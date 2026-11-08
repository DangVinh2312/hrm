package values

import (
	"regexp"
	"strings"

	"hrm/api-go/internal/authorization/core"
)

const fractionDigits = 6

// timestampShape is grammar only (ASCII digits, fixed shape); the calendar is checked apart.
var timestampShape = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$`)

// timestampCodec reads UTC `YYYY-MM-DDTHH:mm:ss[.f{1..6}]Z`, years 0001..9999, and writes exactly six
// fractional digits. It works on text alone, so microseconds survive and no timezone can apply.
type timestampCodec struct{}

func (timestampCodec) Normalize(input core.FieldValue) (core.Scalar, bool) {
	text, isText := input.AsText()
	if !isText {
		return core.Scalar{}, false
	}
	match := timestampShape.FindStringSubmatch(text)
	if match == nil {
		return core.Scalar{}, false
	}
	if !isRealSecond(number(match[1]), number(match[2]), number(match[3]), number(match[4]), number(match[5]), number(match[6])) {
		return core.Scalar{}, false
	}
	fraction := match[7] + strings.Repeat("0", fractionDigits-len(match[7]))
	return core.Text(text[:len("YYYY-MM-DDTHH:mm:ss")] + "." + fraction + "Z"), true
}

// Compare relies on canonical strings being fixed-width UTC: lexicographic order is chronological order.
func (timestampCodec) Compare(left, right core.Scalar) (core.Comparison, error) {
	return compareText(left, right)
}

// number reads digits the shape already matched, so it cannot fail.
func number(digits string) int {
	value := 0
	for _, digit := range []byte(digits) {
		value = value*10 + int(digit-'0')
	}
	return value
}

func isRealSecond(year, month, day, hour, minute, second int) bool {
	return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month) &&
		hour <= 23 && minute <= 59 && second <= 59
}

// daysIn uses the proleptic Gregorian calendar for every year, 0001 included.
func daysIn(year, month int) int {
	switch month {
	case 2:
		if year%4 == 0 && (year%100 != 0 || year%400 == 0) {
			return 29
		}
		return 28
	case 4, 6, 9, 11:
		return 30
	}
	return 31
}
