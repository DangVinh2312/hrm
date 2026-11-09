package config

func RuntimeDatabases(env map[string]string) (DatabaseURLs, error) {
	databases, problems := loadDatabases(env)
	for _, name := range []string{"DATABASE_ADMIN_URL", "PRODUCT_MIGRATION_DATABASE_URL", "PRODUCT_BOOTSTRAP_DATABASE_URL", "PRODUCT_OUTBOX_DATABASE_URL"} {
		if env[name] != "" {
			problems = append(problems, name+" must not be present in the runtime sync process")
		}
	}
	if len(problems) > 0 {
		return DatabaseURLs{}, &ConfigError{problems: problems}
	}
	return databases, nil
}
