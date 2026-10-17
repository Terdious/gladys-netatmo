// -----------------------------------------------------------------------------
// Legrand Home + Control (Céliane / dooxie / Mosaic with Netatmo, issue #60):
// lighting modules and plugs / relays, from the homesdata / homestatus
// payloads (pyatmo modules/legrand.py, Home Assistant `light` / `switch` of
// the netatmo integration).
//
// One Gladys device per module, keyed by its own id; the gateway (NLG / NLGS)
// is not a device, it is the `bridge` of the commands (plug_id param). The
// double switch NLIS has one entry per gang (`<id>#1`, `<id>#2`): each gang is
// a light of its own, the parent entry carries no state and is not exposed.
//
// Reachability (the unreachable badge, and no stale value published): a gang
// never reports `reachable`, it follows its parent module; a module behind an
// unreachable gateway is unreachable too (pyatmo mark_unreachable).
//
// Nobody has validated this on real Legrand hardware yet: the shapes come
// from the pyatmo fixtures (homesdata.json, homestatus_91763b24c43d3e344f424e8b.json,
// homestatus_bridged_home_id.json). The Device diagnostic action shows what a
// real installation reports.
// -----------------------------------------------------------------------------

import {
  LEGRAND_MODULE_TYPES,
  LEGRAND_GATEWAY_TYPES,
  LEGRAND_LIGHT_TYPES,
  LEGRAND_DIMMER_TYPES,
  LEGRAND_SWITCH_TYPES,
  LEGRAND_MULTI_GANG_TYPES,
  SUB_MODULE_SEPARATOR,
} from './constants.js';
import {
  buildFeatureLegrandLight,
  buildFeatureLegrandBrightness,
  buildFeatureLegrandSwitch,
  buildFeatureLegrandPower,
} from './features.js';

/**
 * Whether a Netatmo module type belongs to the Legrand family of the
 * integration (gateway, lighting, plugs and relays).
 * @param {unknown} type module type
 * @returns {boolean} true for a supported Legrand type
 */
export function isLegrandType(type) {
  return LEGRAND_MODULE_TYPES.includes(type);
}

/**
 * The parent id of a gang (`<id>#<n>` → `<id>`), null for any other id.
 * @param {unknown} id Netatmo module id
 * @returns {string|null} the parent module id
 */
export function parentModuleId(id) {
  if (typeof id !== 'string' || !id.includes(SUB_MODULE_SEPARATOR)) {
    return null;
  }
  return id.split(SUB_MODULE_SEPARATOR, 1)[0];
}

/**
 * Why a Legrand module is not a Gladys device, null when it is one: the
 * gateway, or the parent entry of a multi-gang module.
 * @param {object} module raw Legrand module
 * @returns {string|null} the reason
 */
export function legrandNotExposedReason(module) {
  if (LEGRAND_GATEWAY_TYPES.includes(module?.type)) {
    return 'Legrand gateway: not a Gladys device, it relays the commands of its modules';
  }
  if (LEGRAND_MULTI_GANG_TYPES.includes(module?.type) && parentModuleId(module?.id) === null) {
    return 'multi-gang module: each gang (<id>#1, <id>#2…) is a device of its own';
  }
  return null;
}

/**
 * The reachability of the Legrand modules of one home, resolved: a gang
 * without `reachable` takes its parent's; a module whose Legrand gateway is
 * unreachable is unreachable. The other devices are returned as they are.
 * @param {Array} devices raw devices of one home
 * @returns {Array} the devices (Legrand ones copied when their reachability changes)
 */
export function resolveLegrandReachability(devices) {
  const byId = new Map(
    devices.filter((device) => typeof device?.id === 'string').map((device) => [device.id, device]),
  );
  return devices.map((device) => {
    if (!isLegrandType(device?.type) || LEGRAND_GATEWAY_TYPES.includes(device.type)) {
      return device;
    }
    let { reachable } = device;
    const parentId = parentModuleId(device.id);
    if (reachable === undefined && parentId) {
      reachable = byId.get(parentId)?.reachable;
    }
    const gateway = typeof device.bridge === 'string' ? byId.get(device.bridge) : undefined;
    if (gateway && LEGRAND_GATEWAY_TYPES.includes(gateway.type) && gateway.reachable === false) {
      reachable = false;
    }
    return reachable === device.reachable ? device : { ...device, reachable };
  });
}

/**
 * Features of one Legrand module, from what its payload carries: the light
 * (lighting modules) or the switch (plugs and relays) — always; the
 * brightness of a dimmer when homestatus reports one; the instant power when
 * homestatus reports it. null for a module that is not a device (gateway,
 * multi-gang parent).
 * @param {object} module raw Legrand module
 * @param {string} name device name
 * @param {string} externalId device external id
 * @returns {Array<object>|null} its features
 */
export function legrandFeatures(module, name, externalId) {
  if (legrandNotExposedReason(module)) {
    return null;
  }
  const features = [];
  if (LEGRAND_LIGHT_TYPES.includes(module.type)) {
    features.push(buildFeatureLegrandLight(name, externalId));
    if (LEGRAND_DIMMER_TYPES.includes(module.type) && typeof module.brightness === 'number') {
      features.push(buildFeatureLegrandBrightness(name, externalId));
    }
  } else if (LEGRAND_SWITCH_TYPES.includes(module.type)) {
    features.push(buildFeatureLegrandSwitch(name, externalId));
  } else {
    return null;
  }
  if (typeof module.power === 'number') {
    features.push(buildFeatureLegrandPower(name, externalId));
  }
  return features;
}
