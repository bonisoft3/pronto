package pronto

// Scheduled filters cross Bloblang into PostgREST, so their metadata must use
// the portable timestamp spelling rather than Bloblang's native timestamp.
_scheduledCutoff: (#rpkScheduled & {
	p: {
		name:     "purge"
		trigger:  "schedule"
		to:       "Note"
		interval: "30s"
		action:   "delete"
		filter:   "deleted_at=lt.{cutoff}"
		window:   "168h"
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
		interval: "10s"
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
