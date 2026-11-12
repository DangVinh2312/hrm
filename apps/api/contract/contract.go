// Package contract embeds the HTTP and database contract of the API as strings, so no caller can
// change them.
package contract

import _ "embed"

var (
	//go:embed openapi.json
	openAPI string
	//go:embed routes.json
	routes string
	//go:embed privileges.json
	privileges string
)

// OpenAPI is the exact bytes GET /api/openapi.json answers.
func OpenAPI() string { return openAPI }

// Routes is the route inventory of the API; the routes this process does not serve go to NestJS.
func Routes() string { return routes }

// Privileges holds the grants the boot probe compares with the database.
func Privileges() string { return privileges }
