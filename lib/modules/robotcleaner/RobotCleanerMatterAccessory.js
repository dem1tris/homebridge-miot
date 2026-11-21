const fs = require('fs').promises;
const {
  MATTER_RVC_RUN_MODES,
  MATTER_RVC_CLEAN_MODES,
  MATTER_RVC_OPERATIONAL_STATES,
  MATTER_RVC_RUN_MODE_TAGS,
  MATTER_RVC_CLEAN_MODE_TAGS,
  batteryPercentToMatter,
  batteryChargeLevel,
  matterOperationalStateFromFlags,
  normalizeMatterRooms,
  matterMapsFromRooms,
  matterAreasFromRooms
} = require('./RobotCleanerMatterUtils.js');

const SERVICE_AREA_CLUSTER_NAME = 'serviceArea';
const DEFAULT_ROOM_DISCOVERY_INTERVAL_MS = 6 * 60 * 60 * 1000;

const matterMode = (label, mode, modeTags) => ({ label, mode, modeTags: modeTags.map(value => ({ value })) });

class RobotCleanerMatterAccessory {
  constructor(name, device, uuid, config, api, logger, cachedDeviceInfo = {}, restoredMatterAccessory = null, options = {}) {
    this.name = name;
    this.device = device;
    this.uuid = uuid;
    this.config = config || {};
    this.api = api;
    this.logger = logger;
    this.cachedDeviceInfo = cachedDeviceInfo || {};
    this.restoredMatterAccessory = restoredMatterAccessory;
    this.roomCacheFile = options.roomCacheFile;
    this.savedState = restoredMatterAccessory?.context || {};
    this.cacheWrite = Promise.resolve();
    this.selectionInvalid = false;
    this.selectedMapId = null;
    this.cachedRooms = [];
    this.normalizedRooms = [];
    this.lastRoomDiscoveryAt = 0;
    this.roomDiscoveryInFlight = null;
    this.currentCleanMode = MATTER_RVC_CLEAN_MODES.VACUUM;
    this.selectedAreaIds = [];
    this.areaIdToRoom = new Map();
    this.accessory = null;
    this.reachable = false;
  }

  async init() {
    // fail fast if the Homebridge Matter api is missing or does not expose the robot vacuum device type.
    // every other api.matter access is guarded, so without this init() would throw mid-build at _createOrUpdateAccessory.
    if (!this.api.matter || !this.api.matter.deviceTypes || !this.api.matter.deviceTypes.RoboticVacuumCleaner) {
      throw new Error('Homebridge Matter api is not available - cannot expose the robot cleaner through Matter.');
    }

    this.cachedRooms = await this._loadCachedRooms();
    this.selectionInvalid = this.savedState.selectionInvalid === true;
    this.selectedMapId = this.savedState.selectedMapId ?? null;
    this.normalizedRooms = this._getNormalizedRooms();
    this.areaIdToRoom = this._createAreaIdRoomMap(this.normalizedRooms);
    this.selectedAreaIds = this._getRestoredSelectedAreaIds();
    this.accessory = this._createOrUpdateAccessory();
    this._attachHandlers();

    return this;
  }

  getMatterAccessory() {
    return this.accessory;
  }

  updateAccessoryStatus() {
    this._syncMatterState().catch((err) => {
      this.logger.debug(`Matter robot state sync failed: ${err.message}`);
    });

    this._refreshDiscoveredRoomsIfNeeded().catch((err) => {
      this.logger.debug(`Matter robot room discovery failed: ${err.message}`);
    });
  }

  async handleRunModeChange(newMode) {
    this._assertDeviceConnected();
    const selectedRoomIds = newMode === MATTER_RVC_RUN_MODES.CLEANING ? this._getSelectedVendorRoomIds() : [];
    this.logger.info(`Matter run mode change requested: ${newMode}${selectedRoomIds.length > 0 ? ` for rooms ${selectedRoomIds.join(',')}` : ''}`);

    if (newMode === MATTER_RVC_RUN_MODES.CLEANING) {
      const cleaningOptions = this._getCleaningOptions();
      if (selectedRoomIds.length > 0) {
        if (this.selectedMapId) cleaningOptions.mapId = this.selectedMapId;
        await this.device.startRoomCleaning(selectedRoomIds, cleaningOptions);
      } else {
        await this.device.startCleaning(cleaningOptions);
      }
      await this._updateClusterState(this._clusterNames().RvcOperationalState, {
        operationalState: MATTER_RVC_OPERATIONAL_STATES.RUNNING
      });
    } else if (newMode === MATTER_RVC_RUN_MODES.IDLE) {
      await this.device.goHome();
      await this._updateClusterState(this._clusterNames().RvcOperationalState, {
        operationalState: MATTER_RVC_OPERATIONAL_STATES.SEEKING_CHARGER
      });
    } else {
      throw new Error(`Unsupported Matter run mode: ${newMode}`);
    }
  }

  async handleCleanModeChange(newMode) {
    this.logger.info(`Matter clean mode change requested: ${newMode}`);
    const supportedMode = this._getSupportedCleanModes().find(mode => mode.mode === newMode);
    if (!supportedMode) {
      throw new Error(`Matter clean mode ${newMode} is not supported by this robot.`);
    }
    // the clean mode is applied on the next start command (it is read from currentCleanMode).
    // changing it mid-clean has no effect on the running job, so reject it to give the user feedback
    // instead of silently storing a value that appears to do nothing.
    this._assertJobEditable();
    await this._updateClusterState(this._clusterNames().RvcCleanMode, { currentMode: newMode });
    this.currentCleanMode = newMode;
    this._updateContext();
    await this._saveCachedRooms(this.cachedRooms);
  }

  async handlePause() {
    this.logger.info('Matter pause requested.');
    return this._runOperationalCommand('pauseCleaning', MATTER_RVC_OPERATIONAL_STATES.PAUSED, this._roomCommandOptions());
  }

  async handleResume() {
    this.logger.info('Matter resume requested.');
    return this._runOperationalCommand('resumeCleaning', MATTER_RVC_OPERATIONAL_STATES.RUNNING, { ...this._getCleaningOptions(), ...this._roomCommandOptions() });
  }

  async handleGoHome() {
    this.logger.info('Matter go home requested.');
    return this._runOperationalCommand('goHome', MATTER_RVC_OPERATIONAL_STATES.SEEKING_CHARGER);
  }

  async handleIdentify() {
    this._assertDeviceConnected();
    return this.device.identify();
  }

  async _runOperationalCommand(command, operationalState, ...args) {
    this._assertDeviceConnected();
    await this.device[command](...args);
    await this._updateClusterState(this._clusterNames().RvcOperationalState, {
      operationalState
    });
  }

  async handleSelectAreas(request = {}) {
    this._assertJobEditable();
    if (!Array.isArray(request.newAreas)) throw new Error('Area selection must be an array.');
    const newAreas = request.newAreas;
    const supportedAreaIds = new Set(this.normalizedRooms.map(room => room.areaId));
    const invalidArea = newAreas.find(areaId => !supportedAreaIds.has(areaId));
    if (invalidArea != null) {
      throw new Error(`Matter area ${invalidArea} is not known for this robot.`);
    }

    const selectedAreaIds = [...new Set(newAreas)];
    await this._updateClusterState(this._clusterNames().ServiceArea, { selectedAreas: selectedAreaIds });
    this.selectedAreaIds = selectedAreaIds;
    const maps = new Set(selectedAreaIds.map(id => this.areaIdToRoom.get(id).mapId));
    this.selectedMapId = maps.size === 1 ? [...maps][0] : null;
    this.selectionInvalid = false;
    this._updateContext();
    await this._saveCachedRooms(this.cachedRooms);
  }

  async handleSkipArea() {
    throw new Error('Skipping individual areas is not supported by this robot.');
  }

  _createOrUpdateAccessory() {
    const accessory = this.restoredMatterAccessory || {
      UUID: this.uuid,
      displayName: this.name
    };
    const clusters = this._buildClusters(accessory.clusters || {});

    accessory.UUID = this.uuid;
    accessory.displayName = this.name;
    accessory.deviceType = this.api.matter.deviceTypes.RoboticVacuumCleaner;
    accessory.serialNumber = this._getSerialNumber();
    accessory.manufacturer = this._getManufacturerName();
    accessory.model = this.device.getModel() || this.cachedDeviceInfo.model || 'Unknown';
    accessory.firmwareRevision = this.cachedDeviceInfo.firmwareRev || 'Unknown';
    accessory.context = {
      ...(accessory.context || {}),
      plugin: 'homebridge-miot',
      deviceType: this.device.getType(),
      model: accessory.model,
      selectedAreaIds: this.selectedAreaIds,
      rooms: this.normalizedRooms
    };
    accessory.clusters = clusters;
    accessory.getState = async (cluster, attribute) => this.handleStateRead(cluster, attribute);

    return accessory;
  }

  async handleStateRead(cluster, attribute) {
    this.reachable = await this.device.isReachable();
    if (!this.reachable) {
      throw new Error('Robot cleaner is not reachable locally or through MiCloud.');
    }

    const localClusterName = this._localClusterName(cluster);
    return this.accessory?.clusters?.[localClusterName]?.[attribute];
  }

  _attachHandlers() {
    this.accessory.handlers = {
      rvcRunMode: {
        changeToMode: async request => this.handleRunModeChange(request.newMode)
      },
      rvcCleanMode: {
        changeToMode: async request => this.handleCleanModeChange(request.newMode)
      },
      rvcOperationalState: {
        pause: async () => this.handlePause(),
        resume: async () => this.handleResume(),
        goHome: async () => this.handleGoHome()
      }
    };

    if (this._shouldExposeServiceArea()) {
      this.accessory.handlers.serviceArea = {
        selectAreas: async request => this.handleSelectAreas(request),
        skipArea: async request => this.handleSkipArea(request)
      };
    }

    if (this.device.supportsIdentify()) {
      this.accessory.handlers.identify = {
        identify: async () => this.handleIdentify()
      };
    }
  }

  _buildClusters(existingClusters = {}) {
    const powerSourceCluster = this._buildPowerSourceCluster(existingClusters.powerSource);
    const supportedCleanModes = this._getSupportedCleanModes();
    // A currentMode that is not in supportedModes makes Matter.js reject accessory registration
    // ("Behaviors have errors"). The persisted/restored value can fall out of range when the
    // supported clean-mode list changes between versions, so force the published currentMode to a
    // supported one. We consider both our in-memory mode and any restored cluster value. See #762.
    const restoredCleanMode = existingClusters.rvcCleanMode && existingClusters.rvcCleanMode.currentMode;
    // Prefer a previously-selected (restored) mode, then our in-memory mode, and only fall back to
    // the first supported mode if neither is valid - never publish a mode that isn't supported.
    const cleanModeCandidate = [this.savedState.currentCleanMode, restoredCleanMode, this.currentCleanMode]
      .find(mode => supportedCleanModes.some(supported => supported.mode === mode));
    this.currentCleanMode = cleanModeCandidate !== undefined ? cleanModeCandidate : supportedCleanModes[0].mode;
    const clusters = {
      rvcRunMode: this._mergeCluster(existingClusters.rvcRunMode, {
        supportedModes: [
          matterMode('Idle', MATTER_RVC_RUN_MODES.IDLE, [MATTER_RVC_RUN_MODE_TAGS.IDLE]),
          matterMode('Cleaning', MATTER_RVC_RUN_MODES.CLEANING, [MATTER_RVC_RUN_MODE_TAGS.CLEANING])
        ],
        currentMode: this._getRunMode()
      }),
      rvcCleanMode: this._mergeCluster(existingClusters.rvcCleanMode, {
        supportedModes: supportedCleanModes,
        currentMode: this.currentCleanMode
      }),
      rvcOperationalState: this._mergeCluster(existingClusters.rvcOperationalState, {
        operationalStateList: this._getOperationalStateList(),
        operationalState: this._getOperationalState()
      }),
      powerSource: powerSourceCluster
    };

    if (this._shouldExposeServiceArea()) {
      clusters.serviceArea = this._mergeCluster(existingClusters.serviceArea, this._serviceAreaState({
        currentArea: null,
        progress: []
      }));
      // IJAI does not report per-room progress; enabling it would invent values.
      if (this.device.getModel?.() === 'ijai.vacuum.v18') delete clusters.serviceArea.progress;
    }

    return clusters;
  }

  _buildPowerSourceCluster(existingCluster = {}) {
    const batteryState = this._getBatteryState();
    const cluster = {
      ...existingCluster,
      status: 0,
      order: 0,
      description: 'Battery',
      batReplaceability: 1,
      batChargeState: batteryState.batChargeState
    };

    const cachedBatteryPercent = Number(cluster.batPercentRemaining);
    if (this.device.hasKnownBatteryLevel() || !Number.isFinite(cachedBatteryPercent) || cachedBatteryPercent <= 0) {
      cluster.batPercentRemaining = batteryState.batPercentRemaining;
      cluster.batChargeLevel = batteryState.batChargeLevel;
    }

    return cluster;
  }

  _mergeCluster(existingCluster = {}, clusterDefaults = {}) {
    return {
      ...existingCluster,
      ...clusterDefaults
    };
  }

  _getSupportedCleanModes() {
    const presets = this.device.getMatterCleaningPresets?.();
    if (presets) return presets.map(({ options, ...mode }) => mode);

    const modes = [
      matterMode('Vacuum', MATTER_RVC_CLEAN_MODES.VACUUM, [MATTER_RVC_CLEAN_MODE_TAGS.VACUUM])
    ];

    if (this.device.supportsMopCleaning()) {
      modes.push(matterMode('Mop', MATTER_RVC_CLEAN_MODES.MOP, [MATTER_RVC_CLEAN_MODE_TAGS.MOP]));
    }

    if (this.device.supportsCombinedCleaning()) {
      modes.push(matterMode('Vacuum and Mop', MATTER_RVC_CLEAN_MODES.VACUUM_MOP, [
        MATTER_RVC_CLEAN_MODE_TAGS.VACUUM,
        MATTER_RVC_CLEAN_MODE_TAGS.MOP
      ]));
    }

    // Matter requires at least two clean modes, including on vacuum-only robots.
    // Auto uses the existing vacuum start path and the robot's configured defaults.
    if (modes.length === 1) {
      modes.push(matterMode('Auto', MATTER_RVC_CLEAN_MODES.AUTO, [MATTER_RVC_CLEAN_MODE_TAGS.AUTO]));
    }

    return modes;
  }

  _getOperationalStateList() {
    return Object.values(MATTER_RVC_OPERATIONAL_STATES).map(operationalStateId => ({ operationalStateId }));
  }

  _getCleaningOptions(cleanMode = this.currentCleanMode) {
    const preset = this.device.getMatterCleaningPresets?.().find(mode => mode.mode === cleanMode);
    if (preset) return { ...preset.options };

    return {
      vacuum: cleanMode !== MATTER_RVC_CLEAN_MODES.MOP,
      mop: cleanMode === MATTER_RVC_CLEAN_MODES.MOP || cleanMode === MATTER_RVC_CLEAN_MODES.VACUUM_MOP
    };
  }

  _getRunMode() {
    return this.device.isVacuumWorking() ? MATTER_RVC_RUN_MODES.CLEANING : MATTER_RVC_RUN_MODES.IDLE;
  }

  _getOperationalState() {
    return matterOperationalStateFromFlags(this.device.getOperationalStateFlags());
  }

  _getBatteryState() {
    const known = this.device.hasKnownBatteryLevel();
    const batteryPercent = this.device.getBatteryLevel();
    const flags = this.device.getOperationalStateFlags();
    return {
      batPercentRemaining: known ? batteryPercentToMatter(batteryPercent) : null,
      batChargeLevel: known ? batteryChargeLevel(batteryPercent) : 0,
      batChargeState: flags.isFullyCharged ? 2 : flags.isCharging ? 1 : known ? 3 : 0
    };
  }

  async _syncMatterState() {
    if (!this.accessory || !this.api.matter) {
      return;
    }

    this.reachable = await this.device.isReachable();

    await this._updateClusterState(this._clusterNames().RvcRunMode, {
      currentMode: this._getRunMode()
    });
    await this._updateClusterState(this._clusterNames().RvcOperationalState, {
      operationalState: this.reachable ? this._getOperationalState() : MATTER_RVC_OPERATIONAL_STATES.ERROR
    });
    await this._updateClusterState(this._clusterNames().PowerSource, this._getBatteryState());

    if (this._shouldExposeServiceArea()) {
      this.selectedAreaIds = this.selectedAreaIds.filter(areaId => this.areaIdToRoom.has(areaId));
      this._updateContext();
      await this._updateClusterState(this._clusterNames().ServiceArea, this._serviceAreaState());
    }
  }

  async _updateClusterState(clusterName, attributes = {}) {
    if (!clusterName || !this.api.matter || !this.accessory) {
      return;
    }

    const localClusterName = this._localClusterName(clusterName);
    const endpoint = await this.api.matter.getAccessoryState?.(this.uuid, clusterName);
    const currentClusterState = endpoint ? JSON.parse(JSON.stringify(endpoint)) : this.accessory.clusters[localClusterName] || {};
    const changedAttributes = {};

    Object.keys(attributes).forEach((key) => {
      if (JSON.stringify(currentClusterState[key]) !== JSON.stringify(attributes[key])) {
        changedAttributes[key] = attributes[key];
      }
    });

    if (Object.keys(changedAttributes).length === 0) {
      return;
    }

    await this.api.matter.updateAccessoryState(this.uuid, clusterName, changedAttributes);
    this.accessory.clusters[localClusterName] = {
      ...currentClusterState,
      ...changedAttributes
    };
  }

  async _refreshDiscoveredRoomsIfNeeded() {
    if (!this._shouldDiscoverRooms() || !this.device.isLocallyConnected()) {
      return;
    }

    const intervalMs = this._getRoomDiscoveryIntervalMs();
    if (Date.now() - this.lastRoomDiscoveryAt < intervalMs) {
      return;
    }
    if (this.roomDiscoveryInFlight) {
      return this.roomDiscoveryInFlight;
    }

    this.roomDiscoveryInFlight = this._refreshDiscoveredRooms().finally(() => {
      this.roomDiscoveryInFlight = null;
    });

    return this.roomDiscoveryInFlight;
  }

  async _refreshDiscoveredRooms() {
    this.lastRoomDiscoveryAt = Date.now();
    const discoveredRooms = await this.device.discoverRooms(this._roomDiscoveryOptions());
    if (!discoveredRooms || (!discoveredRooms.length && this.device.getModel?.() !== 'ijai.vacuum.v18')) {
      return;
    }

    const previousMapIds = this.normalizedRooms.map(room => room.mapId);
    this.cachedRooms = discoveredRooms;
    this.normalizedRooms = this._getNormalizedRooms();
    this.areaIdToRoom = this._createAreaIdRoomMap(this.normalizedRooms);
    const sameMaps = JSON.stringify([...new Set(previousMapIds)].sort()) ===
      JSON.stringify([...new Set(this.normalizedRooms.map(room => room.mapId))].sort());
    const previousSelection = this.selectedAreaIds;
    this.selectedAreaIds = sameMaps ? previousSelection.filter(areaId => this.areaIdToRoom.has(areaId)) : [];
    this.selectionInvalid ||= this.selectedAreaIds.length !== previousSelection.length;
    await this._saveCachedRooms(discoveredRooms);
    this._updateContext();

    if (this.accessory.clusters && this._shouldExposeServiceArea()) {
      this._attachHandlers();
      await this._updateClusterState(this._clusterNames().ServiceArea, this._serviceAreaState());
    }
  }

  _serviceAreaState(extraState = {}) {
    const supportedMaps = matterMapsFromRooms(this.normalizedRooms);
    const serviceAreaState = {
      supportedMaps,
      supportedAreas: matterAreasFromRooms(this.normalizedRooms),
      selectedAreas: this.selectedAreaIds
    };

    return {
      ...serviceAreaState,
      ...extraState
    };
  }

  _shouldExposeServiceArea() {
    return this.device.supportsRoomCleaning() || this._getConfiguredRooms().length > 0 || this.cachedRooms.length > 0 || this.normalizedRooms.length > 0;
  }

  _shouldDiscoverRooms() {
    return this.config.matterRoomDiscovery !== 'disabled' && this.device.supportsRoomDiscovery(this._roomDiscoveryOptions());
  }

  _roomDiscoveryOptions() {
    return { useMiCloud: this.config.matterRoomDiscoveryMiCloud === true };
  }

  _getNormalizedRooms() {
    return normalizeMatterRooms(this.cachedRooms, this._getConfiguredRooms());
  }

  _getConfiguredRooms() {
    return Array.isArray(this.config.matterRooms) ? this.config.matterRooms : [];
  }

  _getSelectedVendorRoomIds() {
    if (this.selectionInvalid) throw new Error('Select rooms again after the map or room list changed.');
    return this.selectedAreaIds.map(id => {
      const room = this.areaIdToRoom.get(id);
      if (!room) throw new Error('Select rooms again; a selected room is no longer available.');
      return room.vendorId;
    });
  }

  _roomCommandOptions() {
    const roomIds = this._getSelectedVendorRoomIds();
    return roomIds.length ? { roomIds, ...(this.selectedMapId ? { mapId: this.selectedMapId } : {}) } : {};
  }

  _assertJobEditable() {
    if (this.device.isVacuumWorking?.() || this.device.getOperationalStateFlags?.().isPaused) {
      throw new Error('Cannot change a job while it is running or paused.');
    }
  }

  _getRestoredSelectedAreaIds() {
    const restored = this.savedState.selectedAreaIds ?? this.restoredMatterAccessory?.clusters?.serviceArea?.selectedAreas ?? this.config.selectedAreaIds;
    if (!Array.isArray(restored)) return [];
    const selected = [...new Set(restored.filter(id => this.areaIdToRoom.has(id)))];
    this.selectionInvalid ||= selected.length !== restored.length;
    if (!this.selectedMapId && selected.length) this.selectedMapId = this.areaIdToRoom.get(selected[0]).mapId;
    return selected;
  }

  _createAreaIdRoomMap(rooms) {
    return new Map(rooms.map(room => [room.areaId, room]));
  }

  _updateContext() {
    if (this.accessory) {
      this.accessory.context = {
        ...(this.accessory.context || {}),
        selectedAreaIds: this.selectedAreaIds,
        selectedMapId: this.selectedMapId,
        selectionInvalid: this.selectionInvalid,
        currentCleanMode: this.currentCleanMode,
        rooms: this.normalizedRooms
      };
    }
  }

  _assertDeviceConnected() {
    if (this.config.deviceEnabled === false) {
      throw new Error('Robot cleaner is disabled in the Homebridge config.');
    }
    if (!this.device.isConnected()) {
      throw new Error('Robot cleaner is not connected.');
    }
  }

  _clusterNames() {
    return {
      RvcRunMode: 'rvcRunMode',
      RvcCleanMode: 'rvcCleanMode',
      RvcOperationalState: 'rvcOperationalState',
      PowerSource: 'powerSource',
      ServiceArea: SERVICE_AREA_CLUSTER_NAME,
      ...(this.api.matter.clusterNames || {})
    };
  }

  _localClusterName(clusterName) {
    const names = this._clusterNames();
    if (clusterName === names.RvcRunMode) return 'rvcRunMode';
    if (clusterName === names.RvcCleanMode) return 'rvcCleanMode';
    if (clusterName === names.RvcOperationalState) return 'rvcOperationalState';
    if (clusterName === names.PowerSource) return 'powerSource';
    if (clusterName === names.ServiceArea) return SERVICE_AREA_CLUSTER_NAME;
    return clusterName;
  }

  _getRoomDiscoveryIntervalMs() {
    const intervalHours = Number(this.config.matterRoomDiscoveryInterval);
    if (Number.isFinite(intervalHours) && intervalHours >= 1) {
      return intervalHours * 60 * 60 * 1000;
    }
    return DEFAULT_ROOM_DISCOVERY_INTERVAL_MS;
  }

  async _loadCachedRooms() {
    if (!this.roomCacheFile) {
      return [];
    }

    try {
      const cacheContent = await fs.readFile(this.roomCacheFile, 'utf8');
      const parsedCache = JSON.parse(cacheContent);
      this.savedState = { ...this.savedState, ...parsedCache };
      return Array.isArray(parsedCache.rooms) ? parsedCache.rooms : [];
    } catch (err) {
      return this.savedState.rooms?.map(room => ({ ...room, id: room.vendorId ?? room.id })) || [];
    }
  }

  async _saveCachedRooms(rooms) {
    if (!this.roomCacheFile) {
      return;
    }

    const cacheContent = JSON.stringify({
      updatedAt: new Date().toISOString(),
      rooms,
      selectedAreaIds: this.selectedAreaIds,
      selectedMapId: this.selectedMapId,
      selectionInvalid: this.selectionInvalid,
      currentCleanMode: this.currentCleanMode
    }, null, 2);
    const save = this.cacheWrite.then(async () => {
      await fs.writeFile(this.roomCacheFile + '.tmp', cacheContent, 'utf8');
      await fs.rename(this.roomCacheFile + '.tmp', this.roomCacheFile);
    });
    this.cacheWrite = save.catch(() => {});
    return save;
  }

  _getManufacturerName() {
    const model = this.device.getModel() || this.cachedDeviceInfo.model || '';
    if (model.includes('yeelink.')) {
      return 'Yeelight Technology';
    }
    if (model.includes('.')) {
      const manufacturer = model.split('.')[0];
      return manufacturer.charAt(0).toUpperCase() + manufacturer.substring(1);
    }
    return 'Xiaomi';
  }

  _getSerialNumber() {
    return this.device.getMiotDevice().getDeviceId() || this.cachedDeviceInfo.deviceId || this.uuid;
  }
}

module.exports = RobotCleanerMatterAccessory;
