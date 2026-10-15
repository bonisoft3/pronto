// conduit, finding no publication, made its own without the generated
// columns, and every DELETE under the FULL replica identity failed with 42P10.
package emit

import (
	"strings"

	pronto "github.com/bonisoft3/pronto"
)

_publication: (pronto.#publication & {name: "p", tables: ["t"]}).out

publicationOptions: strings.HasSuffix(_publication, "END $$;\nALTER PUBLICATION p SET (publish_generated_columns = stored);") & true

// The feed stamps a marker `__table: txn_trace`, so an app table by that name
// would read to a consumer as a transaction boundary.
markerUnshadowed: ((pronto.#txnMarker & {pub: "p", tables: ["t", "txn_trace"]}).out == _|_) & true
