package hrbase

// RequestKind is the kind of a work request. The five values have distinct first letters, so byte order
// equals the localeCompare order the sheet sorts by.
type RequestKind string

const (
	RequestLateArrival    RequestKind = "late-arrival"
	RequestEarlyDeparture RequestKind = "early-departure"
	RequestWfh            RequestKind = "wfh"
	RequestAnnualLeave    RequestKind = "annual-leave"
	RequestUnpaidLeave    RequestKind = "unpaid-leave"
)
