package database

// ProtectionBody gives a declared body, so a test can restore a function it neutralized.
func ProtectionBody(name string) string {
	for _, function := range protectionFunctions {
		if function.name == name {
			return function.body
		}
	}
	panic("no protection function " + name)
}
