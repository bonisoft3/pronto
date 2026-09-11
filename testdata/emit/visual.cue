// The visual battery's compose commands, pinned: both run under mise's env,
// where the app publishes COMPOSE_PROJECT_NAME, and the closure run names the
// project that env publishes, else the app's own — never a literal the
// environment cannot override.
package emit

import pronto "github.com/bonisoft3/pronto"

_visual: (pronto.#DefaultTerminal & {code: _code}).out.surface.checks.visual.cmds
visualBoot: _visual[0]
visualBoot: "mise exec -- docker compose up -d --wait --build launch"
visualRun: _visual[len(_visual)-1]
visualRun: "mise exec -- docker compose -p (^mise exec -- printenv COMPOSE_PROJECT_NAME | complete | get stdout | str trim | str replace -r '^$' 'emit') --profile '*' -f .bayt/compose.integrate.closure.yaml up bayt --abort-on-container-failure --exit-code-from bayt --build --remove-orphans --attach-dependencies"
