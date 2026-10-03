import { metersBetween } from './shared';

// Approximate reference points on the Urbana-Champaign campus, used to describe a position
// in words for dispatchers. Coordinates are rounded and are not survey-grade.
const LANDMARKS: Array<{ name: string; latitude: number; longitude: number }> = [
  { name: 'Illini Union', latitude: 40.1092, longitude: -88.2272 },
  { name: 'Alma Mater (Green & Wright)', latitude: 40.1100, longitude: -88.2283 },
  { name: 'Foellinger Auditorium', latitude: 40.1059, longitude: -88.2272 },
  { name: 'Lincoln Hall', latitude: 40.1069, longitude: -88.2285 },
  { name: 'Main Library', latitude: 40.1047, longitude: -88.2291 },
  { name: 'Grainger Engineering Library', latitude: 40.1125, longitude: -88.2269 },
  { name: 'Siebel Center for Computer Science', latitude: 40.1138, longitude: -88.2249 },
  { name: 'Beckman Institute', latitude: 40.1158, longitude: -88.2273 },
  { name: 'Krannert Center', latitude: 40.1080, longitude: -88.2224 },
  { name: 'Illinois Street Residence Halls (ISR)', latitude: 40.1093, longitude: -88.2212 },
  { name: 'Green St & Sixth St', latitude: 40.1103, longitude: -88.2296 },
  { name: 'Green St & Fourth St', latitude: 40.1104, longitude: -88.2330 },
  { name: 'Ikenberry Commons', latitude: 40.1037, longitude: -88.2355 },
  { name: 'Activities and Recreation Center (ARC)', latitude: 40.1014, longitude: -88.2361 },
  { name: 'Memorial Stadium', latitude: 40.0992, longitude: -88.2360 },
  { name: 'State Farm Center', latitude: 40.0962, longitude: -88.2359 },
  { name: 'Pennsylvania Avenue Residence Halls (PAR)', latitude: 40.1000, longitude: -88.2206 },
  { name: 'Florida Avenue Residence Halls (FAR)', latitude: 40.0985, longitude: -88.2216 },
];

const DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function describeNearLandmark(latitude: number, longitude: number): string {
  let best = LANDMARKS[0];
  let bestDistance = Infinity;
  for (const landmark of LANDMARKS) {
    const distance = metersBetween(landmark, { latitude, longitude });
    if (distance < bestDistance) { best = landmark; bestDistance = distance; }
  }
  if (bestDistance > 2000) return 'Off campus';
  if (bestDistance < 40) return `At ${best.name}`;
  const dy = latitude - best.latitude;
  const dx = (longitude - best.longitude) * Math.cos(latitude * Math.PI / 180);
  const bearing = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  return `~${Math.round(bestDistance / 10) * 10} m ${DIRECTIONS[Math.round(bearing / 45) % 8]} of ${best.name}`;
}
