"""flightlog SHIM — flightsim_replay'in kullandığı saf parçalar (HEPGO app/flightlog.py'den birebir): `_mode_names` (ArduPilot mod adları) ve `WARN_RE`."""
import re

from pymavlink import mavutil

SIMUMAV_SHIM = True
WARN_RE = re.compile(r'failsafe|crash|error|fail(ed|ure)?\b|warning|\bbad\b|\blost\b|glitch|emergency|critical|'
                     r'prearm|unhealthy|breach|low batt|battery low|\bestop', re.I)


def _mode_names(firmware):
    fw = (firmware or '').lower()
    if 'plane' in fw:
        mapping = mavutil.mode_mapping_apm
    elif 'copter' in fw or 'heli' in fw:
        mapping = mavutil.mode_mapping_acm
    elif 'rover' in fw:
        mapping = mavutil.mode_mapping_rover
    elif 'sub' in fw:
        mapping = mavutil.mode_mapping_sub
    else:
        mapping = mavutil.mode_mapping_apm
    if not mapping:
        return {}
    return dict(mapping)
