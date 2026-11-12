// Package values holds the value codecs the composition root injects into core.New. Core never imports it.
package values

import (
	"cmp"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"hrm/api/internal/authorization/core"
)

var (
	errNotComparable = errors.New("compare needs two normalized values of the codec's kind")

	decimalPattern = regexp.MustCompile(`^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$`)
	uuidPattern    = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

// Codecs returns the value codecs of the product. They hold no state, so the table can be built anywhere.
func Codecs() core.ValueCodecs {
	return core.ValueCodecs{
		Timestamp: timestampCodec{},
		Integer:   integerCodec{},
		Decimal:   decimalCodec{},
		UUID:      uuidCodec{},
		String:    stringCodec{},
		Boolean:   booleanCodec{},
	}
}

func comparison(order int) core.Comparison {
	switch {
	case order < 0:
		return core.Less
	case order > 0:
		return core.Greater
	}
	return core.Equal
}

func compareText(left, right core.Scalar) (core.Comparison, error) {
	l, leftText := left.AsText()
	r, rightText := right.AsText()
	if !leftText || !rightText {
		return 0, errNotComparable
	}
	return comparison(strings.Compare(l, r)), nil
}

// equalOnly answers Greater for different values: uuid and boolean define no order.
func equalOnly(same bool) core.Comparison {
	if same {
		return core.Equal
	}
	return core.Greater
}

// integerCodec is an exact int64; the round trip through FormatInt refuses every non-canonical spelling.
type integerCodec struct{}

func parseInteger(text string) (int64, bool) {
	value, err := strconv.ParseInt(text, 10, 64)
	return value, err == nil && strconv.FormatInt(value, 10) == text
}

func (integerCodec) Normalize(input core.FieldValue) (core.Scalar, bool) {
	text, isText := input.AsText()
	if !isText {
		return core.Scalar{}, false
	}
	if _, ok := parseInteger(text); !ok {
		return core.Scalar{}, false
	}
	return core.Text(text), true
}

func (integerCodec) Compare(left, right core.Scalar) (core.Comparison, error) {
	l, leftText := left.AsText()
	r, rightText := right.AsText()
	if !leftText || !rightText {
		return 0, errNotComparable
	}
	x, leftOK := parseInteger(l)
	y, rightOK := parseInteger(r)
	if !leftOK || !rightOK {
		return 0, errNotComparable
	}
	return comparison(cmp.Compare(x, y)), nil
}

// decimalCodec keeps the literal as given, so 10.0 and 10.00 stay distinct; Compare ignores scale and -0.
type decimalCodec struct{}

type decimalParts struct {
	negative      bool
	whole, digits string
}

func parseDecimal(text string) (decimalParts, bool) {
	match := decimalPattern.FindStringSubmatch(text)
	if match == nil {
		return decimalParts{}, false
	}
	digits := strings.TrimRight(match[3], "0")
	return decimalParts{
		negative: match[1] == "-" && (match[2] != "0" || digits != ""),
		whole:    match[2],
		digits:   digits,
	}, true
}

func (decimalCodec) Normalize(input core.FieldValue) (core.Scalar, bool) {
	text, isText := input.AsText()
	if !isText || !decimalPattern.MatchString(text) {
		return core.Scalar{}, false
	}
	return core.Text(text), true
}

func (decimalCodec) Compare(left, right core.Scalar) (core.Comparison, error) {
	l, leftText := left.AsText()
	r, rightText := right.AsText()
	if !leftText || !rightText {
		return 0, errNotComparable
	}
	x, leftOK := parseDecimal(l)
	y, rightOK := parseDecimal(r)
	if !leftOK || !rightOK {
		return 0, errNotComparable
	}
	if x.negative != y.negative {
		if x.negative {
			return core.Less, nil
		}
		return core.Greater, nil
	}
	magnitude := compareMagnitude(x, y)
	if x.negative {
		magnitude = -magnitude
	}
	return comparison(magnitude), nil
}

// compareMagnitude works on digit strings; whole has no leading zero, so length orders first.
func compareMagnitude(x, y decimalParts) int {
	if order := cmp.Compare(len(x.whole), len(y.whole)); order != 0 {
		return order
	}
	if order := strings.Compare(x.whole, y.whole); order != 0 {
		return order
	}
	width := max(len(x.digits), len(y.digits))
	return strings.Compare(x.digits+strings.Repeat("0", width-len(x.digits)), y.digits+strings.Repeat("0", width-len(y.digits)))
}

type uuidCodec struct{}

func (uuidCodec) Normalize(input core.FieldValue) (core.Scalar, bool) {
	text, isText := input.AsText()
	if !isText || !uuidPattern.MatchString(text) {
		return core.Scalar{}, false
	}
	return core.Text(strings.ToLower(text)), true
}

func (uuidCodec) Compare(left, right core.Scalar) (core.Comparison, error) {
	l, leftText := left.AsText()
	r, rightText := right.AsText()
	if !leftText || !rightText {
		return 0, errNotComparable
	}
	return equalOnly(l == r), nil
}

// stringCodec keeps exact bytes: no trim, no case folding, no Unicode normalization. For valid UTF-8,
// byte order equals code point order and PostgreSQL `COLLATE "C"`. The 256-byte key limit belongs to
// core.ParseKey, not to this value codec.
type stringCodec struct{}

func (stringCodec) Normalize(input core.FieldValue) (core.Scalar, bool) {
	text, isText := input.AsText()
	if !isText || !utf8.ValidString(text) {
		return core.Scalar{}, false
	}
	return core.Text(text), true
}

func (stringCodec) Compare(left, right core.Scalar) (core.Comparison, error) {
	return compareText(left, right)
}

type booleanCodec struct{}

func (booleanCodec) Normalize(input core.FieldValue) (core.Scalar, bool) {
	value, isBool := input.AsBool()
	if !isBool {
		return core.Scalar{}, false
	}
	return core.Bool(value), true
}

func (booleanCodec) Compare(left, right core.Scalar) (core.Comparison, error) {
	l, leftBool := left.AsBool()
	r, rightBool := right.AsBool()
	if !leftBool || !rightBool {
		return 0, errNotComparable
	}
	return equalOnly(l == r), nil
}
