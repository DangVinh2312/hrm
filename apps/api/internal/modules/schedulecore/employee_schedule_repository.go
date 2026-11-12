package schedulecore

import (
	"github.com/jackc/pgx/v5"

	"hrm/api/internal/database"
)

type storedEmployeeSchedule struct {
	StoredSchedule `json:",inline"`
	Versions       []StoredVersion `json:"versions"`
}

// EmployeeSchedule is the schedule of one employee from the first to the last of dates: the calendar days
// at calendar version (the caller holds that row FOR SHARE when it writes), the company versions and the
// employee's own frames, from one statement so one snapshot.
func EmployeeSchedule(tx *database.Tx, employee string, dates []string, version string) (ScheduleFacts, error) {
	from := `(SELECT min(d) FROM unnest(CAST($2 AS date[])) d)`
	next := `(SELECT max(d) FROM unnest(CAST($2 AS date[])) d) + 1`
	rows, err := tx.Query(`WITH days AS (
         SELECT DISTINCT ON (c.day) to_char(c.day,'YYYY-MM-DD') AS day, c.kind, c.as_weekday, c.frame_source
           FROM work_calendar_change c
          WHERE c.day >= `+from+` AND c.day < `+next+` AND c.version <= CAST($3 AS int8)
          ORDER BY c.day, c.version DESC)
       SELECT json_build_object(
                'versions', `+ScheduleVersionsSQL(from, next)+`,
                'frames', `+EmployeeFramesSQL("CAST($1 AS uuid)", from, next)+`,
                'holidays', COALESCE((SELECT json_agg(day) FROM days WHERE kind = 'paid_holiday'), '[]'::json),
                'makeupDays', COALESCE((SELECT json_agg(json_build_object('date', day, 'asWeekday', as_weekday,
                                'frameSource', frame_source)) FROM days WHERE kind = 'makeup_workday'), '[]'::json)
              )::text AS stored`, employee, dates, version)
	if err != nil {
		return ScheduleFacts{}, err
	}
	raw, err := pgx.CollectExactlyOneRow(rows, pgx.RowTo[string])
	if err != nil {
		return ScheduleFacts{}, err
	}
	stored, err := DecodeStored[storedEmployeeSchedule]([]byte(raw))
	if err != nil {
		return ScheduleFacts{}, err
	}
	return Facts(ScheduleVersions(stored.Versions), stored.StoredSchedule), nil
}
