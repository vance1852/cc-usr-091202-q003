// 地理计算：经纬度距离与包围盒，全部使用米制。
const EARTH_RADIUS_M = 6_371_000;
const DEG = Math.PI / 180;

export function haversineM([lngA, latA], [lngB, latB]) {
  const dLat = (latB - latA) * DEG;
  const dLng = (lngB - lngA) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(latA * DEG) * Math.cos(latB * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// 近线查询用的粗筛包围盒，避免对全部点做球面距离。
export function boundingBox(lng, lat, radiusM) {
  const latDelta = (radiusM / EARTH_RADIUS_M) / DEG;
  const lngDelta = Math.abs(Math.cos(lat * DEG)) < 1e-12
    ? 180
    : (radiusM / EARTH_RADIUS_M) / DEG / Math.cos(lat * DEG);
  return {
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
  };
}
