package pronto

// Scheduled filters cross Bloblang into PostgREST, so their metadata must use
// the portable timestamp spelling rather than Bloblang's native timestamp.
_scheduledCutoff: (#rpkScheduled & {
	p: {
		name:     "purge"
		trigger:  "schedule"
		to:       "Note"
		interval: "PT30S"
		action:   "delete"
		filter:   "deleted_at=lt.{cutoff}"
		window:   "PT168H"
	}
	sinkTable: "note"
}).out.pipeline.processors[0].bloblang

_scheduledCutoff: """
meta cutoff = (timestamp_unix() - 604800).ts_format("2006-01-02T15:04:05.000000Z", "UTC")
root = {}
"""

_scheduledNowts: (#rpkScheduled & {
	p: {
		name:     "remind-due"
		trigger:  "schedule"
		to:       "Note"
		interval: "PT10S"
		action:   "update"
		filter:   "due=is.false&remind_at=lte.{nowts}"
		set: due: true
	}
	sinkTable: "note"
}).out.pipeline.processors[0].bloblang

_scheduledNowts: """
meta nowts = now().ts_format("2006-01-02T15:04:05.000000Z", "UTC")
root = {"due":true}
"""

// Redpanda Connect reads a Go duration: the period crosses in its spelling.
_scheduledInterval: (#rpkScheduled & {
	p: {
		name:     "purge"
		trigger:  "schedule"
		to:       "Note"
		interval: "PT1H30M"
		action:   "delete"
		filter:   "id=is.null"
	}
	sinkTable: "note"
}).out.input.generate.interval

_scheduledInterval: "1h30m"
