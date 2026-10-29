const R = 6_371_008.8; // mean Earth radius, metres
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface Point { id: number; lat: number; lng: number; radius_m: number }

/**
 * Inside if within ANY point's radius. Returns the point with the smallest (distance - radius),
 * i.e. the one that passes, or the closest miss.
 */
export function nearestPoint(lat: number, lng: number, points: Point[]): { point: Point; distanceM: number; inside: boolean } | null {
  let best: { point: Point; distanceM: number; inside: boolean } | null = null;
  let bestMargin = Infinity;
  for (const p of points) {
    const d = haversineM(lat, lng, p.lat, p.lng);
    if (d - p.radius_m < bestMargin) {
      bestMargin = d - p.radius_m;
      best = { point: p, distanceM: d, inside: d <= p.radius_m };
    }
  }
  return best;
}
