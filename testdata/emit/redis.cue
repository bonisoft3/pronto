package emit

// Redis saves relative to its working directory. Bayt's project directory is
// root-owned, so its first snapshot would fail and stop subsequent writes.
redisDirectory: _scheduledCluster.surface.targets.redis.dockerfile.workdir & "/data"
