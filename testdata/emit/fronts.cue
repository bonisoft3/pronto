package emit

import "strings"

// surface.fronts: the emitted door reads each front's sites variable, in
// declaration order, in place of SITES; without fronts it reads SITES.
_frontsCase: #routeSegmentsCase & {
	_app: surface: fronts: {
		retail: sites:  "RETAIL_SITES"
		partner: sites: "PARTNER_SITES"
	}
}

frontsSites:    strings.Contains(_frontsCase.out.caddyfile, "\n    {$RETAIL_SITES}\n    {$PARTNER_SITES}\n    default - - -\n") & true
frontsNoSites:  strings.Contains(_frontsCase.out.caddyfile, "{$SITES}") & false
frontlessSites: strings.Contains(routeSegments.caddyfile, "\n    {$SITES}\n    default - - -\n") & true
