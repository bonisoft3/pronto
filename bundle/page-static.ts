// The page of an app with no server entity: the shell behind the shim
// (page-core.ts) and nothing else, so neither the cluster nor PGlite rides in
// its module, and the page fetches no database at boot.
import { startPage } from './page-core.ts'

startPage()
