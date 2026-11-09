package settingcore

import (
	"errors"
	"slices"
)

type Key string

// GroupRule is HR rules (permission updateRule), GroupProfile is company information (updateProfile).
type Group string
type Unit string
type Kind string

type ValueKind uint8

const (
	GroupRule    Group = "rule"
	GroupProfile Group = "profile"

	UnitMinutes Unit = "minutes"
	UnitDays    Unit = "days"
	UnitMonths  Unit = "months"
	UnitRows    Unit = "rows"
	UnitBytes   Unit = "bytes"

	KindInt  Kind = "int"
	KindText Kind = "text"
	KindEnum Kind = "enum"
)

// The zero ValueKind is no value at all, so a Value nobody filled in is refused.
const (
	ValueInt ValueKind = iota + 1
	ValueText
)

const (
	KeyAnnualLeaveDefaultMinutes Key = "hr.annualLeaveDefaultMinutes"
	KeyWfhMonthLimit             Key = "hr.wfhMonthLimit"
	KeyRequestWindowPastDays     Key = "hr.requestWindowPastDays"
	KeyRequestWindowFutureDays   Key = "hr.requestWindowFutureDays"
	KeyRequestMaxDays            Key = "hr.requestMaxDays"
	KeyWorkdayMaxMinutes         Key = "hr.workdayMaxMinutes"
	KeyReportMaxMonths           Key = "report.maxMonths"
	KeyExportMaxRows             Key = "export.maxRows"
	KeyExportMaxBytes            Key = "export.maxBytes"
	KeyCompanyName               Key = "company.name"
	KeyCompanyDefaultLocale      Key = "company.defaultLocale"
)

var ErrStoredInvalid = errors.New("stored setting is invalid")

type Value struct {
	Kind ValueKind
	Int  int64
	Text string
}

func IntValue(n int64) Value   { return Value{Kind: ValueInt, Int: n} }
func TextValue(s string) Value { return Value{Kind: ValueText, Text: s} }

// Definition is the code-owned shape of one key. Min and Max are set for KindInt, MaxLength (code
// points after trimming, 0 meaning "use the product name") for KindText, Values for KindEnum.
// The upper bound of a "lower only" setting is the constant it replaces, so the old behavior is the
// ceiling. The default of every setting is itself a value Validate accepts.
type Definition struct {
	Kind      Kind
	Group     Group
	Unit      Unit
	Default   Value
	Min, Max  int64
	MaxLength int
	Values    []string
}

func intRule(unit Unit, def, lo, hi int64) Definition {
	return Definition{Kind: KindInt, Group: GroupRule, Unit: unit, Default: IntValue(def), Min: lo, Max: hi}
}

var registry = map[Key]Definition{
	KeyAnnualLeaveDefaultMinutes: intRule(UnitMinutes, 5760, 5760, 175_680),
	KeyWfhMonthLimit:             intRule(UnitDays, 4, 0, 31),
	KeyRequestWindowPastDays:     intRule(UnitDays, 7, 0, 31),
	KeyRequestWindowFutureDays:   intRule(UnitDays, 90, 0, 365),
	KeyRequestMaxDays:            intRule(UnitDays, 31, 1, 31),
	KeyWorkdayMaxMinutes:         intRule(UnitMinutes, 480, 60, 720),
	KeyReportMaxMonths:           intRule(UnitMonths, 12, 1, 12),
	KeyExportMaxRows:             intRule(UnitRows, 5000, 1, 5000),
	KeyExportMaxBytes:            intRule(UnitBytes, 5_242_880, 1_048_576, 5_242_880),
	KeyCompanyName:               {Kind: KindText, Group: GroupProfile, Default: TextValue(""), MaxLength: 120},
	KeyCompanyDefaultLocale:      {Kind: KindEnum, Group: GroupProfile, Default: TextValue("vi"), Values: []string{"vi", "en"}},
}

var keys = []Key{
	KeyAnnualLeaveDefaultMinutes, KeyWfhMonthLimit, KeyRequestWindowPastDays, KeyRequestWindowFutureDays,
	KeyRequestMaxDays, KeyWorkdayMaxMinutes, KeyReportMaxMonths, KeyExportMaxRows, KeyExportMaxBytes,
	KeyCompanyName, KeyCompanyDefaultLocale,
}

func Keys() []Key { return slices.Clone(keys) }

// Lookup is the definition of a registered key, a copy the caller may change; false for anything else.
func Lookup(key string) (Definition, bool) {
	def, ok := registry[Key(key)]
	def.Values = slices.Clone(def.Values)
	return def, ok
}
