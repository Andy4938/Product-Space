// A short loop around the Main Quad. Demo points are sent as simulated positions.
export const DEMO_PATH: Array<[number, number]> = [
  [40.10939, -88.22717],
  [40.10908, -88.22718],
  [40.10870, -88.22720],
  [40.10835, -88.22720],
  [40.10798, -88.22721],
  [40.10761, -88.22723],
  [40.10726, -88.22726],
  [40.10691, -88.22728],
  [40.10668, -88.22740],
  [40.10669, -88.22788],
  [40.10671, -88.22834],
  [40.10702, -88.22837],
  [40.10740, -88.22837],
  [40.10776, -88.22836],
  [40.10812, -88.22836],
  [40.10850, -88.22835],
  [40.10888, -88.22835],
  [40.10927, -88.22834],
];

export function demoLocation(index: number) {
  const [latitude, longitude] = DEMO_PATH[index % DEMO_PATH.length];
  return { latitude, longitude, accuracy: 12, recordedAt: new Date().toISOString() };
}
