package workrequest

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"errors"

	"hrm/api/internal/apperror"
	"hrm/api/internal/modules/hrbase"
	"hrm/api/internal/modules/schedulecore"
)

type rejection string

const (
	rejectCrossesYear    rejection = "crosses_year"
	rejectDateOutOfRange rejection = "date_out_of_range"
	rejectNotEmployed    rejection = "not_employed"
	rejectProbation      rejection = "kind_not_allowed_in_probation"
	rejectInvalidTime    rejection = "invalid_time"
	rejectInvalidSlot    rejection = "invalid_slot"
	rejectNonWorkingDay  rejection = "non_working_day"
	rejectMakeupDay      rejection = "makeup_day"
)

// rejected is the first submit rule a request breaks; ruleError maps it to the answer.
type rejected struct{ reason rejection }

func (r rejected) Error() string { return "work request rejected: " + string(r.reason) }

// ruleCodes are the rules over facts the submitter may know (the window, the year, their own status on the
// day, the calendar). A time outside a shift, a non-slot interval and a day outside employment stay 400.
var ruleCodes = map[rejection]apperror.Code{
	rejectCrossesYear:    "error.crossesYear",
	rejectDateOutOfRange: "error.dateOutOfRange",
	rejectProbation:      "error.kindNotAllowedInProbation",
	rejectNonWorkingDay:  "error.nonWorkingDay",
	rejectMakeupDay:      "error.makeupDay",
}

func ruleError(reason rejection) error {
	if code, ok := ruleCodes[reason]; ok {
		return apperror.Rejection{Code: code}
	}
	return apperror.ErrInvalidRequest
}

// submitFacts are read in the submit transaction: no clock and no host timezone here.
type submitFacts struct {
	// Earliest and Latest are today − hr.requestWindowPastDays and today + hr.requestWindowFutureDays, inclusive.
	Earliest, Latest string
	Schedule         schedulecore.ScheduleFacts
	// StatusOn is statusProbation, statusOfficial or "" outside employment.
	StatusOn func(date string) string
}

func requestDates(input SubmitInput) []string {
	switch {
	case input.Dates != nil:
		return input.Dates
	case input.Segments != nil:
		dates := make([]string, len(input.Segments))
		for i, s := range input.Segments {
			dates[i] = s.Date
		}
		return dates
	}
	return []string{input.Date}
}

func timeOnly(kind hrbase.RequestKind) bool {
	return kind == hrbase.RequestLateArrival || kind == hrbase.RequestEarlyDeparture
}

func probationKind(kind hrbase.RequestKind) bool {
	return timeOnly(kind) || kind == hrbase.RequestUnpaidLeave
}

func checkDays(input SubmitInput, facts submitFacts) error {
	dates := requestDates(input)
	if dates[0][:4] != dates[len(dates)-1][:4] {
		return rejected{rejectCrossesYear}
	}
	for _, date := range dates {
		if date < facts.Earliest || date > facts.Latest {
			return rejected{rejectDateOutOfRange}
		}
		status := facts.StatusOn(date)
		if status != statusProbation && status != statusOfficial {
			return rejected{rejectNotEmployed}
		}
		if status == statusProbation && !probationKind(input.Kind) {
			return rejected{rejectProbation}
		}
	}
	return nil
}

func leaveSegments(slots []Slot, schedule schedulecore.ScheduleFacts) ([]Segment, error) {
	segments := make([]Segment, 0, len(slots))
	for _, s := range slots {
		day, err := schedulecore.FrameOn(s.Date, schedule)
		if err != nil {
			return nil, err
		}
		minutes, err := schedulecore.LeaveMinutes(day, s.StartMinute, s.EndMinute)
		if refused, ok := errors.AsType[schedulecore.WorkingTimeRejected](err); ok {
			switch refused.Reason {
			case schedulecore.RejectInvalidSlot, schedulecore.RejectNonWorkingDay, schedulecore.RejectMakeupDay:
				return nil, rejected{rejection(refused.Reason)}
			case schedulecore.RejectInvalidDate:
			}
		}
		if err != nil {
			return nil, err
		}
		segments = append(segments, Segment{Date: s.Date, StartMinute: s.StartMinute, EndMinute: s.EndMinute, Minutes: minutes})
	}
	return segments, nil
}

// requestSegments are the segments of a validated request, one per date, or the first rule it breaks:
// never across a calendar year, then per date the window, employment and probation on that very day, then
// the schedule. WFH and late/early need a workday or a makeup day and follow that day's frame.
func requestSegments(input SubmitInput, facts submitFacts) ([]Segment, error) {
	if err := checkDays(input, facts); err != nil {
		return nil, err
	}
	if input.Segments != nil {
		return leaveSegments(input.Segments, facts.Schedule)
	}
	dates := requestDates(input)
	frames := make([]schedulecore.Frame, len(dates))
	for i, date := range dates {
		day, err := schedulecore.FrameOn(date, facts.Schedule)
		if err != nil {
			return nil, err
		}
		if day.Kind != schedulecore.DayWorkday && day.Kind != schedulecore.DayMakeupWorkday {
			return nil, rejected{rejectNonWorkingDay}
		}
		frames[i] = day.Frame
	}
	if input.Kind == hrbase.RequestWfh {
		segments := make([]Segment, len(dates))
		for i, date := range dates {
			wfh, ok := schedulecore.WfhSegment(frames[i])
			if !ok {
				return nil, rejected{rejectNonWorkingDay}
			}
			segments[i] = Segment{Date: date, StartMinute: wfh.Start, EndMinute: wfh.End, Minutes: wfh.Minutes}
		}
		return segments, nil
	}
	segment, ok := schedulecore.LateSegment(frames[0], input.ExpectedMinute)
	if input.Kind == hrbase.RequestEarlyDeparture {
		segment, ok = schedulecore.EarlySegment(frames[0], input.ExpectedMinute)
	}
	if !ok {
		return nil, rejected{rejectInvalidTime}
	}
	return []Segment{{Date: input.Date, StartMinute: segment[0], EndMinute: segment[1], Minutes: segment[1] - segment[0]}}, nil
}

// bookedSegment is a segment of a pending or approved request of the same employee.
type bookedSegment struct {
	Kind        hrbase.RequestKind
	Date        string
	StartMinute int
	EndMinute   int
}

// conflicts: no crossing times with booked requests, except late/early on a WFH day (either order), and
// at most one late arrival and one early departure per day, even apart in time.
func conflicts(kind hrbase.RequestKind, segments []Segment, booked []bookedSegment) bool {
	for _, b := range booked {
		for _, s := range segments {
			if s.Date != b.Date || (timeOnly(kind) && b.Kind == hrbase.RequestWfh) || (kind == hrbase.RequestWfh && timeOnly(b.Kind)) {
				continue
			}
			if (timeOnly(kind) && b.Kind == kind) || (s.StartMinute < b.EndMinute && b.StartMinute < s.EndMinute) {
				return true
			}
		}
	}
	return false
}

type start struct {
	State string
	// SystemDecision is the system_reason of the decision written at submit, "" for none.
	SystemDecision string
}

// initialState: a COO's request is approved at submit, the current lead of the chosen team skips the lead
// step, everyone else waits for the lead.
func initialState(submitterIsCoo, submitterLeadsTeam bool) start {
	switch {
	case submitterIsCoo:
		return start{stateApproved, systemCooSelfApproved}
	case submitterLeadsTeam:
		return start{statePendingFinal, systemLeadSkipped}
	}
	return start{statePendingLead, ""}
}

type timedHash struct {
	Kind           hrbase.RequestKind `json:"kind"`
	TeamID         *string            `json:"teamId"`
	Reason         string             `json:"reason"`
	Date           string             `json:"date"`
	ExpectedMinute int                `json:"expectedMinute"`
}

type wfhHash struct {
	Kind   hrbase.RequestKind `json:"kind"`
	TeamID *string            `json:"teamId"`
	Reason string             `json:"reason"`
	Dates  []string           `json:"dates"`
}

type leaveHash struct {
	Kind     hrbase.RequestKind `json:"kind"`
	TeamID   *string            `json:"teamId"`
	Reason   string             `json:"reason"`
	Segments []Slot             `json:"segments"`
}

// payloadHash is the SHA-256 hex of the normalized body as JSON.stringify writes it: the members of its
// kind in the validator's order, the key not included. encoding/json v2 escapes only what JSON requires,
// as JSON.stringify does.
func payloadHash(input SubmitInput) (string, error) {
	var payload []byte
	var err error
	switch {
	case timeOnly(input.Kind):
		payload, err = json.Marshal(timedHash{input.Kind, input.TeamID, input.Reason, input.Date, input.ExpectedMinute})
	case input.Kind == hrbase.RequestWfh:
		payload, err = json.Marshal(wfhHash{input.Kind, input.TeamID, input.Reason, input.Dates})
	default:
		payload, err = json.Marshal(leaveHash{input.Kind, input.TeamID, input.Reason, input.Segments})
	}
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:]), nil
}
