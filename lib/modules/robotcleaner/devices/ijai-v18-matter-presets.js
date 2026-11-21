const {
  MATTER_RVC_CLEAN_MODES: MODE,
  MATTER_RVC_CLEAN_MODE_TAGS: { VACUUM, MOP }
} = require('../RobotCleanerMatterUtils.js');

// Common ModeTag values from the Matter RvcCleanMode cluster.
const QUIET = 2;
const MIN = 6;
const MAX = 7;

function preset(mode, label, tags, settings = {}) {
  return {
    mode,
    label,
    modeTags: tags.map(value => ({ value })),
    options: {
      vacuum: tags.includes(VACUUM),
      mop: tags.includes(MOP),
      ...settings
    }
  };
}

function getV18MatterCleaningPresets() {
  // Mode IDs are persisted by Homebridge, so retain them when editing this list.
  return [
    preset(MODE.VACUUM, 'Vacuum', [VACUUM]),
    preset(MODE.MOP, 'Mop', [MOP]),
    preset(MODE.VACUUM_MOP, 'Vacuum and Mop', [VACUUM, MOP]),
    preset(3, 'Quiet Vacuum', [VACUUM, QUIET], { suction: 0 }),
    preset(4, 'Max Suction Vacuum', [VACUUM, MAX], { suction: 3 }),
    preset(5, 'Low Water Mop', [MOP, MIN], { water: 0 }),
    preset(6, 'High Water Mop', [MOP, MAX], { water: 2 }),
    preset(7, 'Quiet Vacuum and Mop', [VACUUM, MOP, QUIET], { suction: 0 }),
    preset(8, 'Max Suction Vacuum and Mop', [VACUUM, MOP, MAX], { suction: 3 })
  ];
}

module.exports = getV18MatterCleaningPresets;
