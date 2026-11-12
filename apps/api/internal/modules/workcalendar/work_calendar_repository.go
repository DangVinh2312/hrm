package workcalendar

import (
	"github.com/jackc/pgx/v5"

	"hrm/api/internal/database"
	"hrm/api/internal/modules/schedulecore"
)

const (
	selectCurrentDay = `SELECT c.version::text AS version, COALESCE(d.kind, 'standard') AS kind, d.name,
              d.as_weekday AS "asWeekday", d.frame_source AS "frameSource"
         FROM work_calendar c
         LEFT JOIN LATERAL (SELECT x.kind, x.name, x.as_weekday, x.frame_source FROM work_calendar_change x
                WHERE x.day = CAST($2 AS date) AND x.version <= c.version
                ORDER BY x.version DESC LIMIT 1) d ON true
        WHERE c.id = $1`
	insertDay = `WITH bumped AS (UPDATE work_calendar SET version = version + 1 WHERE id = $1 RETURNING version)
       INSERT INTO work_calendar_change(version,day,kind,name,as_weekday,frame_source)
         SELECT version, CAST($2 AS date), $3, $4, $5, $6 FROM bumped RETURNING version::text AS version`
	selectCurrentDays = `SELECT c.version::text AS version, to_char(t.day, 'YYYY-MM-DD') AS day,
              COALESCE(d.kind, 'standard') AS kind, d.name
         FROM work_calendar c
         CROSS JOIN unnest(CAST($2 AS date[])) AS t(day)
         LEFT JOIN LATERAL (SELECT x.kind, x.name FROM work_calendar_change x
                WHERE x.day = t.day AND x.version <= c.version
                ORDER BY x.version DESC LIMIT 1) d ON true
        WHERE c.id = $1
        ORDER BY t.day`
	insertHolidays = `WITH bumped AS (UPDATE work_calendar SET version = version + $3 WHERE id = $1 RETURNING version),
            written AS (
              INSERT INTO work_calendar_change(version,day,kind,name)
                SELECT bumped.version - $3 + t.ord, CAST(t.day AS date), 'paid_holiday', $4
                  FROM bumped, unnest(CAST($2 AS text[])) WITH ORDINALITY AS t(day, ord)
                RETURNING 1)
       SELECT bumped.version::text AS version FROM bumped`
)

// storedDay is the calendar row and the latest change of one day at the current version.
type storedDay struct {
	Version     string
	Kind        string
	Name        *string
	AsWeekday   *int
	FrameSource *string
}

type storedRangeDay struct {
	Version string
	Day     string
	Kind    string
	Name    *string
}

// versionsBetween is the company schedule versions in force on some day of from..to (business dates).
func versionsBetween(tx *database.Tx, from, to string) ([]schedulecore.ScheduleVersion, error) {
	rows, err := tx.Query(`SELECT (`+schedulecore.ScheduleVersionsSQL("CAST($1 AS date)", "CAST($2 AS date) + 1")+`)::text AS versions`, from, to)
	if err != nil {
		return nil, err
	}
	raw, err := pgx.CollectExactlyOneRow(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	stored, err := schedulecore.DecodeStored[[]schedulecore.StoredVersion]([]byte(raw))
	if err != nil {
		return nil, err
	}
	return schedulecore.ScheduleVersions(stored), nil
}

func companyWorks(date string, weekday int, versions []schedulecore.ScheduleVersion) (bool, error) {
	frame, err := schedulecore.CompanyFrameOn(date, weekday, versions)
	return len(frame) > 0, err
}

func currentDay(tx *database.Tx, calendar, date string) ([]storedDay, error) {
	rows, err := tx.Query(selectCurrentDay, calendar, date)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[storedDay])
}

func writeDay(tx *database.Tx, calendar, date, kind string, name *string, makeup *MakeupHours) (string, error) {
	var asWeekday, frameSource any
	if makeup != nil {
		asWeekday, frameSource = makeup.AsWeekday, string(makeup.FrameSource)
	}
	rows, err := tx.Query(insertDay, calendar, date, kind, name, asWeekday, frameSource)
	if err != nil {
		return "", err
	}
	return pgx.CollectExactlyOneRow(rows, pgx.RowTo[string])
}

func currentDays(tx *database.Tx, calendar string, days []string) ([]storedRangeDay, error) {
	rows, err := tx.Query(selectCurrentDays, calendar, days)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[storedRangeDay])
}

// writeHolidays gives each day its own version, consecutive in the order of days.
func writeHolidays(tx *database.Tx, calendar string, days []string, name string) (string, error) {
	rows, err := tx.Query(insertHolidays, calendar, days, len(days), name)
	if err != nil {
		return "", err
	}
	return pgx.CollectExactlyOneRow(rows, pgx.RowTo[string])
}
