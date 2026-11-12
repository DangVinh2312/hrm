package core

// Comparison has no zero member, so a codec that forgets to answer never reads as equal.
type Comparison uint8

const (
	Less Comparison = iota + 1
	Equal
	Greater
)

// ScalarCodec is a pure value codec: no clock, timezone, trimming or lenient parsing.
type ScalarCodec interface {
	// Normalize returns the canonical value, or false when input is not a valid value of this kind.
	Normalize(input FieldValue) (Scalar, bool)

	// Compare orders two already normalized values.
	Compare(left, right Scalar) (Comparison, error)
}

type ValueCodecs struct {
	Timestamp ScalarCodec
	Integer   ScalarCodec
	Decimal   ScalarCodec
	UUID      ScalarCodec
	String    ScalarCodec
	Boolean   ScalarCodec
}
