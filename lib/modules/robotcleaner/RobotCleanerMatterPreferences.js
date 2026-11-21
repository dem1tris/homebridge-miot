const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');

const FIRST_MAPPED_AREA_ID = 0x80000000;
const LAST_AREA_ID = 0xffffffff;

function isValidPreferences(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.rooms) || !Array.isArray(value.roomAreaIds) ||
      !Array.isArray(value.selectedAreaIds) || !value.selectedRoomKeys || typeof value.selectedRoomKeys !== 'object' ||
      typeof value.selectionInvalid !== 'boolean' || !Number.isInteger(value.currentCleanMode)) {
    return false;
  }

  const keys = new Set();
  const ids = new Set();
  for (const entry of value.roomAreaIds) {
    if (!Array.isArray(entry) || entry.length !== 2) return false;
    const [key, id] = entry;
    if (typeof key !== 'string' || !Number.isInteger(id) || id < FIRST_MAPPED_AREA_ID || id > LAST_AREA_ID ||
        keys.has(key) || ids.has(id)) return false;
    keys.add(key);
    ids.add(id);
  }

  return value.selectedAreaIds.every(id => Number.isInteger(id) && id > 0 && id <= LAST_AREA_ID &&
    typeof value.selectedRoomKeys[id] === 'string');
}

async function readPreferences(file) {
  if (!file) return {};

  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (isValidPreferences(data)) return { preferences: data };
    if (data?.version === undefined && Array.isArray(data?.rooms)) return { legacyRooms: data.rooms };
    return { invalid: true };
  } catch (err) {
    return { invalid: err.code !== 'ENOENT' };
  }
}

async function writePreferences(file, preferences) {
  if (!file) return;

  const temporaryFile = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryFile, JSON.stringify(preferences), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporaryFile, file);
  } finally {
    await fs.rm(temporaryFile, { force: true });
  }
}

function getMappedAreaId(key, registry) {
  if (registry.has(key)) return registry.get(key);

  // Previous versions allocated IDs below 65535 without including the map.
  // Use a separate range and retain every mapping so an old ID cannot be reassigned.
  const usedIds = new Set(registry.values());
  const hash = createHash('sha256').update(key).digest().readUInt32BE(0);
  let id = FIRST_MAPPED_AREA_ID + hash % FIRST_MAPPED_AREA_ID;
  while (usedIds.has(id)) {
    id = id === LAST_AREA_ID ? FIRST_MAPPED_AREA_ID : id + 1;
  }
  registry.set(key, id);
  return id;
}

module.exports = { getMappedAreaId, isValidPreferences, readPreferences, writePreferences };
