// conduit, finding no publication, made its own without the generated
// columns, and every DELETE under the FULL replica identity failed with 42P10.
package emit

import (
	"strings"

	pronto "github.com/bonisoft3/pronto"
)

_publication: (pronto.#publication & {name: "p", tables: ["t"]}).out

publicationOptions: strings.HasSuffix(_publication, "END $$;\nALTER PUBLICATION p SET (publish_generated_columns = stored);") & true
