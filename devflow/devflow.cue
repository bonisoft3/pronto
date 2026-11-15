// The board this repository's pull requests move: bsoneca/pronto's PRONTO project, set up from that
// repository (its devflow/devflow.cue names the node and the team). Here the board and its token
// alone, as pronto-plugins' devflow/schema.cue allows a repository that only reports to a board
// (bsoneca/ume does the same): the `plane` workflow's hook moves an issue whose key a pull request
// names (PRONTO-204).
package devflow

devFlow: {
	board: {
		host:      "plane.bsoneca.com"
		workspace: "pronto"
		project: {name: "pronto", identifier: "PRONTO"}
	}
	token: project: "brawl-chess"
}
