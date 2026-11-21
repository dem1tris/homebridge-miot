const { isDeepStrictEqual } = require('node:util');
const { getMappedAreaId, isValidPreferences, readPreferences, writePreferences } = require('./RobotCleanerMatterPreferences.js');
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
const ROOM_DISCOVERY_RETRY_MS = 60 * 1000;

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
    this.existingMatterStorage = options.existingMatterStorage === true;
    this.cachedRooms = [];
    this.normalizedRooms = [];
    this.lastRoomDiscoveryAt = null;
    this.lastDiscoveryFailure = null;
    this.roomDiscoveryInFlight = null;
    this.currentCleanMode = MATTER_RVC_CLEAN_MODES.VACUUM;
    this.restoredPreferenceMode = false;
    this.selectedAreaIds = [];
    this.selectedRoomKeys = {};
    this.selectionInvalid = false;
    this.lastRoomDiscoveryMapId = null;
    this.roomAreaIds = new Map();
    this.areaIdToRoom = new Map();
    this.preferenceChanges = Promise.resolve();
    this.accessory = null;
    this.reachable = false;
  }

  async init() {
    // fail fast if the Homebridge Matter api is missing or does not expose the robot vacuum device type.
    // every other api.matter access is guarded, so without this init() would throw mid-build at _createOrUpdateAccessory.
    if (!this.api.matter || !this.api.matter.deviceTypes || !this.api.matter.deviceTypes.RoboticVacuumCleaner) {
      throw new Error('Homebridge Matter api is not available - cannot expose the robot cleaner through Matter.');
    }

    await this._restorePreferences();
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
    if (newMode === MATTER_RVC_RUN_MODES.CLEANING) await this.preferenceChanges;
    this._assertDeviceConnected();
    const selectedRoomIds = newMode === MATTER_RVC_RUN_MODES.CLEANING ? this._getSelectedVendorRoomIds() : [];
    this.logger.info(`Matter run mode change requested: ${newMode}${selectedRoomIds.length > 0 ? ` for rooms ${selectedRoomIds.join(',')}` : ''}`);

    if (newMode === MATTER_RVC_RUN_MODES.CLEANING) {
      const cleaningOptions = this._getCleaningOptions();
      if (selectedRoomIds.length > 0) {
        if (this._usesMappedAreas()) cleaningOptions.mapId = this._getCurrentMapId();
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
    return this._queuePreferenceChange(async () => {
      this._assertJobEditable();
      await this._updateClusterState(this._clusterNames().RvcCleanMode, { currentMode: newMode });
      await this._commitPreferences({ currentCleanMode: newMode });
    });
  }

  async handlePause() {
    this.logger.info('Matter pause requested.');
    await this.preferenceChanges;
    const roomIds = this._getSelectedVendorRoomIds();
    const options = roomIds.length && this._usesMappedAreas()
      ? { roomIds, mapId: this._getCurrentMapId() } : {};
    return this._runOperationalCommand('pauseCleaning', MATTER_RVC_OPERATIONAL_STATES.PAUSED, options);
  }

  async handleResume() {
    this.logger.info('Matter resume requested.');
    await this.preferenceChanges;
    const roomIds = this._getSelectedVendorRoomIds();
    const supportsRoomResume = this.device.supportsRoomResume?.() ?? Boolean(this.device.resumeSweepAction?.());
    if (roomIds.length && !supportsRoomResume) {
      throw new Error('This robot cannot safely resume a selected-room job.');
    }
    const options = this._getCleaningOptions();
    if (roomIds.length && this._usesMappedAreas()) Object.assign(options, { roomIds, mapId: this._getCurrentMapId() });
    return this._runOperationalCommand('resumeCleaning', MATTER_RVC_OPERATIONAL_STATES.RUNNING, options);
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
    if (!Array.isArray(request?.newAreas)) throw new Error('Area selection must be an array.');
    const selectedAreaIds = [...new Set(request.newAreas)];
    return this._queuePreferenceChange(async () => {
      this._assertJobEditable();
      const mapId = this._getCurrentMapId();
      const roomKeys = new Map();
      for (const id of selectedAreaIds) {
        const room = this.areaIdToRoom.get(id);
        if (!room || (this._usesMappedAreas() && (!mapId || room.mapId !== mapId))) {
          throw new Error(`Matter area ${id} is not known on the active map.`);
        }
        roomKeys.set(id, this._roomKey(room));
      }
      await this._updateClusterState(this._clusterNames().ServiceArea, { selectedAreas: selectedAreaIds });
      await this._commitPreferences({
        selectedAreaIds,
        selectedRoomKeys: Object.fromEntries(roomKeys),
        selectionInvalid: false
      });
    });
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
    accessory.context ??= {};
    Object.assign(accessory.context, {
      plugin: 'homebridge-miot',
      deviceType: this.device.getType(),
      model: accessory.model,
      ...this._contextState()
    });
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
    // The preferences file records changes immediately; Homebridge may restore an older cluster.
    // Without saved preferences, retain upstream precedence for restored cluster values.
    const candidates = this.restoredPreferenceMode
      ? [this.currentCleanMode, restoredCleanMode] : [restoredCleanMode, this.currentCleanMode];
    const cleanModeCandidate = candidates
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
        operationalState: this._getOperationalState(),
        operationalError: this._getOperationalError()
      }),
      powerSource: powerSourceCluster
    };

    if (this._shouldExposeServiceArea()) {
      clusters.serviceArea = this._mergeCluster(existingClusters.serviceArea, this._serviceAreaState({ currentArea: null }));
      if (this._usesMappedAreas()) {
        // ProgressReporting synthesizes per-area progress from selections, which v18 does not report.
        delete clusters.serviceArea.progress;
      } else {
        clusters.serviceArea.progress = [];
      }
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
    if (presets?.length) {
      return presets.map(({ label, mode, modeTags }) => ({ label, mode, modeTags: modeTags.map(tag => ({ ...tag })) }));
    }

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
    const preset = this.device.getMatterCleaningPresets?.()?.find(({ mode }) => mode === cleanMode);
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
    const flags = this.device.getOperationalStateFlags();
    // PowerSource.BatChargeState in installed matter.js 0.17.9.
    const batChargeState = flags.isFullyCharged ? 2 : flags.isCharging ? 1 : known ? 3 : 0;
    return {
      batPercentRemaining: known ? batteryPercentToMatter(this.device.getBatteryLevel()) : null,
      batChargeLevel: known ? batteryChargeLevel(this.device.getBatteryLevel()) : 0,
      batChargeState
    };
  }

  _getOperationalError(unreachable = false) {
    if (unreachable) {
      return { errorStateId: 2, errorStateDetails: 'Robot unavailable. Cannot read its state.' };
    }
    if (typeof this.device.getMatterOperationalError === 'function') {
      const { errorStateLabel, ...error } = this.device.getMatterOperationalError();
      // Matter allows a label only for manufacturer-specific operational errors.
      if (errorStateLabel !== undefined && error.errorStateId >= 0x80 && error.errorStateId <= 0xbf) {
        error.errorStateLabel = errorStateLabel;
      }
      return error;
    }
    const flags = this.device.getOperationalStateFlags();
    return { errorStateId: flags.hasFault || flags.isError ? 2 : 0 };
  }

  async _syncMatterState() {
    if (!this.accessory || !this.api.matter) {
      return;
    }

    this.reachable = await this.device.isReachable();

    await this._updateClusterState(this._clusterNames().RvcRunMode, {
      currentMode: this._getRunMode()
    }, true);
    await this._updateClusterState(this._clusterNames().RvcOperationalState, {
      operationalState: this.reachable ? this._getOperationalState() : MATTER_RVC_OPERATIONAL_STATES.ERROR,
      operationalError: this._getOperationalError(!this.reachable)
    }, true);
    await this._updateClusterState(this._clusterNames().PowerSource, this._getBatteryState(), true);

    await this._queuePreferenceChange(async () => {
      await this._updateClusterState(this._clusterNames().RvcCleanMode, { currentMode: this.currentCleanMode }, true);
      if (this._shouldExposeServiceArea()) {
        await this._syncRoomInventory();
        await this._updateClusterState(this._clusterNames().ServiceArea, this._serviceAreaState(), true);
      }
    });
  }

  async _updateClusterState(clusterName, attributes = {}, verifyEndpoint = false) {
    if (!clusterName || !this.api.matter || !this.accessory) {
      return;
    }

    const localClusterName = this._localClusterName(clusterName);
    let currentClusterState = this.accessory.clusters[localClusterName] || {};
    if (verifyEndpoint && typeof this.api.matter.getAccessoryState === 'function') {
      // A successful dispatch can still fail at the endpoint. Take a plain
      // snapshot of the live matter.js state proxies on the next poll.
      const endpointState = await this.api.matter.getAccessoryState(this.uuid, clusterName);
      currentClusterState = endpointState ? JSON.parse(JSON.stringify(endpointState)) : {};
    }
    const changedAttributes = {};

    Object.keys(attributes).forEach((key) => {
      if (!isDeepStrictEqual(currentClusterState[key], attributes[key])) {
        changedAttributes[key] = attributes[key];
      }
    });

    if (Object.keys(changedAttributes).length === 0) {
      return;
    }

    const update = { ...changedAttributes };
    if (update.operationalError) {
      // Matter patches struct members in place. An omitted member keeps its old value.
      update.operationalError = { errorStateLabel: undefined, errorStateDetails: undefined, ...update.operationalError };
    }
    await this.api.matter.updateAccessoryState(this.uuid, clusterName, update);
    this.accessory.clusters[localClusterName] = {
      ...(this.accessory.clusters[localClusterName] || {}),
      ...changedAttributes
    };
  }

  async _refreshDiscoveredRoomsIfNeeded() {
    if (!this._shouldDiscoverRooms() || !this.device.isLocallyConnected()) {
      return;
    }

    if (this.roomDiscoveryInFlight) {
      return this.roomDiscoveryInFlight;
    }

    const mapId = this._getCurrentMapId();
    if (this._usesMappedAreas() && !mapId) return;
    const now = Date.now();
    if (this.lastRoomDiscoveryAt !== null && this.lastRoomDiscoveryMapId === mapId &&
        now - this.lastRoomDiscoveryAt < this._getRoomDiscoveryIntervalMs()) return;
    if (this.lastDiscoveryFailure?.mapId === mapId && now - this.lastDiscoveryFailure.at < ROOM_DISCOVERY_RETRY_MS) return;

    this.roomDiscoveryInFlight = this._refreshDiscoveredRooms()
      .catch(error => {
        this.lastDiscoveryFailure = { mapId, at: Date.now() };
        throw error;
      })
      .finally(() => {
        this.roomDiscoveryInFlight = null;
      });

    return this.roomDiscoveryInFlight;
  }

  async _refreshDiscoveredRooms() {
    const mapId = this._getCurrentMapId();
    const discoveredRooms = await this.device.discoverRooms(this._roomDiscoveryOptions());
    if (!Array.isArray(discoveredRooms)) throw new Error('Invalid room discovery result.');
    if (!discoveredRooms.length && !this._usesMappedAreas()) return;

    await this._queuePreferenceChange(async () => {
      if (this._usesMappedAreas() && (!mapId || mapId !== this._getCurrentMapId())) {
        throw new Error('The active map changed during room discovery.');
      }
      // Older adapters return an empty list even when discovery fails. Only the
      // v18 discovery path distinguishes a confirmed empty roster from failure.
      if (discoveredRooms.length || this._usesMappedAreas()) {
        await this._syncRoomInventory(discoveredRooms);
      }
      this.lastRoomDiscoveryAt = Date.now();
      this.lastRoomDiscoveryMapId = mapId;
      this.lastDiscoveryFailure = null;

      if (this._shouldExposeServiceArea()) {
        this._attachHandlers();
        await this._updateClusterState(this._clusterNames().ServiceArea, this._serviceAreaState());
      }
    });
  }

  _serviceAreaState(extraState = {}) {
    const supportedMaps = matterMapsFromRooms(this.normalizedRooms);
    const serviceAreaState = {
      supportedMaps,
      supportedAreas: matterAreasFromRooms(this.normalizedRooms),
      selectedAreas: this.selectedAreaIds.filter(id => this.areaIdToRoom.has(id))
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

  async _syncRoomInventory(cachedRooms = this.cachedRooms, forcePersist = false) {
    const mapId = this._getCurrentMapId();
    const roomAreaIds = new Map(this.roomAreaIds);
    const normalizedRooms = this._getNormalizedRooms(cachedRooms, mapId, roomAreaIds);
    const areaIdToRoom = new Map(normalizedRooms.map(room => [room.areaId, room]));
    const selectedAreaIds = this._usesMappedAreas() && !mapId ? this.selectedAreaIds : this.selectedAreaIds.filter(id => {
      const key = this._roomKey(areaIdToRoom.get(id));
      return key !== null && key === this.selectedRoomKeys[id];
    });
    const selectionInvalid = this.selectionInvalid || selectedAreaIds.length !== this.selectedAreaIds.length;
    const changes = { cachedRooms, roomAreaIds, normalizedRooms, areaIdToRoom, selectedAreaIds, selectionInvalid };
    if (forcePersist || !isDeepStrictEqual(this._preferencesState(), this._preferencesState(changes))) {
      await this._commitPreferences(changes);
    } else {
      Object.assign(this, changes);
      this._updateContext();
    }
  }

  _getNormalizedRooms(cachedRooms, mapId, roomAreaIds) {
    if (!this._usesMappedAreas()) return normalizeMatterRooms(cachedRooms, this._getConfiguredRooms());
    if (!mapId) return [];

    const discoveredRooms = cachedRooms.filter(room => String(room?.mapId) === mapId);
    const discoveredIds = new Set(discoveredRooms.map(room => String(room.id)));
    const overrides = this._getConfiguredRooms().filter(room => {
      if (!room || !discoveredIds.has(String(room.id))) return false;
      const configuredMapId = room.mapId ?? room.map_id;
      return configuredMapId == null || String(configuredMapId) === mapId;
    }).map(({ id, name, areaType }) => ({ id, name, areaType }));
    return normalizeMatterRooms(discoveredRooms, overrides).map(room => ({
      ...room,
      areaId: getMappedAreaId(this._roomKey(room), roomAreaIds)
    }));
  }

  _getConfiguredRooms() {
    return Array.isArray(this.config.matterRooms) ? this.config.matterRooms : [];
  }

  _getSelectedVendorRoomIds() {
    if (this.selectionInvalid) throw new Error('Selected rooms changed. Select rooms again before cleaning.');
    const mapId = this._getCurrentMapId();
    return this.selectedAreaIds.map(id => {
      const room = this.areaIdToRoom.get(id);
      if (this._usesMappedAreas() && (!mapId || room?.mapId !== mapId)) {
        throw new Error('The active map changed or is unknown. Select rooms on the current map.');
      }
      if (!room || this._roomKey(room) !== this.selectedRoomKeys[id]) {
        throw new Error('Selected rooms changed. Select rooms again before cleaning.');
      }
      return room.vendorId;
    });
  }

  _usesMappedAreas() {
    return this.device.getModel?.() === 'ijai.vacuum.v18';
  }

  _getCurrentMapId() {
    const value = this.device._getCurrentMapId?.();
    if (this._usesMappedAreas()) {
      const id = Number(value);
      return Number.isInteger(id) && id > 0 && id <= 0xffffffff ? String(id) : null;
    }
    return value == null || value === '' || value === 0 ? null : String(value);
  }

  _roomKey(room) {
    return room ? JSON.stringify([room.mapId, room.vendorId]) : null;
  }

  _assertJobEditable() {
    const flags = this.device.getOperationalStateFlags();
    if (flags.isWorking || flags.isPaused || this.device.isVacuumWorking()) {
      throw new Error('Cannot change a cleaning job while it is in progress or paused.');
    }
  }

  async _restorePreferences() {
    const { preferences, legacyRooms, invalid } = await readPreferences(this.roomCacheFile);
    const context = this.restoredMatterAccessory?.context;
    const contextPreferences = context?.matterRobotPreferences;
    const restored = preferences ?? (!invalid && isValidPreferences(contextPreferences) ? contextPreferences : null);
    this.selectionInvalid = restored?.selectionInvalid ?? Boolean(invalid || (this._usesMappedAreas() && (this.existingMatterStorage || legacyRooms)));

    if (restored) {
      this.cachedRooms = restored.rooms;
      this.roomAreaIds = new Map(restored.roomAreaIds);
      this.selectedAreaIds = restored.selectedAreaIds;
      this.selectedRoomKeys = restored.selectedRoomKeys;
    } else {
      const cachedAreas = this.restoredMatterAccessory?.clusters?.serviceArea?.selectedAreas;
      const areaIds = context?.selectedAreaIds ?? cachedAreas ?? this.config.selectedAreaIds;
      if (this._usesMappedAreas()) {
        // Previously advertised IDs were not map-qualified. They must never be
        // interpreted against a room roster read on a later map.
        this.selectionInvalid ||= Array.isArray(areaIds) && areaIds.length > 0;
      } else {
        const contextRooms = Array.isArray(context?.rooms) ? context.rooms : [];
        this.cachedRooms = legacyRooms ?? contextRooms.map(room => ({ ...room, id: room.vendorId ?? room.id }));
        this.selectedAreaIds = Array.isArray(areaIds) ? [...new Set(areaIds)] : [];
        const roomsById = new Map(normalizeMatterRooms(this.cachedRooms, this._getConfiguredRooms()).map(room => [room.areaId, room]));
        this.selectedRoomKeys = context?.selectedRoomKeys ?? Object.fromEntries(this.selectedAreaIds.map(id => [id, this._roomKey(roomsById.get(id))]));
        this.selectionInvalid ||= context?.selectionInvalid === true;
      }
    }

    const cleanMode = restored?.currentCleanMode ?? context?.currentCleanMode ?? this.restoredMatterAccessory?.clusters?.rvcCleanMode?.currentMode;
    if (this._getSupportedCleanModes().some(mode => mode.mode === cleanMode)) {
      this.currentCleanMode = cleanMode;
      this.restoredPreferenceMode = restored !== null && restored !== undefined;
    }
    await this._syncRoomInventory(this.cachedRooms, true);
  }

  _preferencesState(state = this) {
    return {
      version: 1,
      rooms: state.cachedRooms ?? this.cachedRooms,
      roomAreaIds: [...(state.roomAreaIds ?? this.roomAreaIds)],
      currentCleanMode: state.currentCleanMode ?? this.currentCleanMode,
      selectedAreaIds: state.selectedAreaIds ?? this.selectedAreaIds,
      selectedRoomKeys: state.selectedRoomKeys ?? this.selectedRoomKeys,
      selectionInvalid: state.selectionInvalid ?? this.selectionInvalid
    };
  }

  _contextState() {
    return {
      currentCleanMode: this.currentCleanMode,
      selectedRoomKeys: this.selectedRoomKeys,
      selectionInvalid: this.selectionInvalid,
      selectedAreaIds: this.selectedAreaIds,
      rooms: this.normalizedRooms,
      matterRobotPreferences: this._preferencesState()
    };
  }

  _updateContext() {
    if (this.accessory) Object.assign(this.accessory.context ??= {}, this._contextState());
  }

  _queuePreferenceChange(change) {
    const pending = this.preferenceChanges.then(change);
    this.preferenceChanges = pending.catch(() => {});
    return pending;
  }

  async _commitPreferences(changes) {
    await writePreferences(this.roomCacheFile, this._preferencesState(changes));
    Object.assign(this, changes);
    this._updateContext();
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
    if (Number.isFinite(intervalHours) && intervalHours >= 1 / 12) {
      return intervalHours * 60 * 60 * 1000;
    }
    return DEFAULT_ROOM_DISCOVERY_INTERVAL_MS;
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
