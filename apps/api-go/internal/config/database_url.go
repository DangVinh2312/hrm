package config

import (
	"net/url"
	"strings"
)

// rawUsername reads the username as written: url.Userinfo decodes it, and `product%5Fdata` is another
// username for the check below, as it is for WHATWG URL.
func rawUsername(raw string) string {
	_, rest, found := strings.Cut(raw, "://")
	if !found {
		return ""
	}
	if end := strings.IndexAny(rest, "/?#"); end >= 0 {
		rest = rest[:end]
	}
	at := strings.LastIndex(rest, "@")
	if at < 0 {
		return ""
	}
	username, _, _ := strings.Cut(rest[:at], ":")
	return username
}

// parseDatabaseURL never returns the url.Parse error: its message holds the URL and the password.
func parseDatabaseURL(raw, login string) (*url.URL, bool) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, false
	}
	if parsed.Scheme != "postgres" && parsed.Scheme != "postgresql" {
		return nil, false
	}
	if parsed.Hostname() == "" || len(parsed.EscapedPath()) < 2 || rawUsername(raw) != login {
		return nil, false
	}
	return parsed, true
}

func databaseIdentity(parsed *url.URL) string {
	port := parsed.Port()
	if port == "" {
		port = "5432"
	}
	return parsed.Hostname() + ":" + port + parsed.EscapedPath()
}

func loadDatabases(env map[string]string) (DatabaseURLs, []string) {
	var databases DatabaseURLs
	var problems []string
	identities := map[string]bool{}
	for _, entry := range []struct {
		purpose string
		target  *string
	}{
		{"data", &databases.Data},
		{"identity", &databases.Identity},
		{"authority", &databases.Authority},
		{"sync", &databases.Sync},
	} {
		key := "PRODUCT_" + strings.ToUpper(entry.purpose) + "_DATABASE_URL"
		parsed, ok := parseDatabaseURL(env[key], "product_"+entry.purpose)
		if !ok {
			problems = append(problems, key+" must identify its dedicated product login")
			continue
		}
		*entry.target = env[key]
		identities[databaseIdentity(parsed)] = true
	}
	if len(problems) == 0 && len(identities) != 1 {
		problems = append(problems, "PRODUCT database URLs must point to one database")
	}
	return databases, problems
}
