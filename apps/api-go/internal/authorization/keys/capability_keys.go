package keys

type ProductValidator string

const (
	ProductValidatorFresh ProductValidator = "fresh@1"
)

type ProductObligation string

const (
	ProductObligationAudit ProductObligation = "audit@1"
)
