'use strict';

const os = require('os');

// Returns the directed broadcast address for every active non-loopback IPv4 interface.
// e.g. for 192.168.31.246 / 255.255.255.0 → "192.168.31.255"
// This is more reliable than 255.255.255.255 because it goes out on the correct
// interface and is not confused by multi-homed hosts.
function getSubnetBroadcasts() {
  const results = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const ip   = iface.address.split('.').map(Number);
      const mask = iface.netmask.split('.').map(Number);
      const bcast = ip.map((b, i) => b | (~mask[i] & 255)).join('.');
      results.push(bcast);
    }
  }
  return results;
}

// Returns all non-loopback IPv4 addresses for display / diagnostics
function getLocalIPs() {
  const ips = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

module.exports = { getSubnetBroadcasts, getLocalIPs };
