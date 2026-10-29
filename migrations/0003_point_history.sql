-- Editing a location retires its old geofence points instead of deleting them: check-in attempts reference the
-- exact point they were judged against (checkins.point_id), so those rows must stay.
ALTER TABLE geofence_points ADD COLUMN retired_at INTEGER;
CREATE INDEX geofence_points_active ON geofence_points (location_id) WHERE retired_at IS NULL;
