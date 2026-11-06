#!/usr/bin/env bash
set -euo pipefail

jar="${1:?Supply the Feldera compiler jar}"
javap -classpath "$jar" org.apache.calcite.rel.rules.CoreRules |
    rg 'TABLE_FUNCTION|WINDOW'
javap -c -p -classpath "$jar" org.apache.calcite.adapter.enumerable.EnumerableTableFunctionScan |
    rg 'class |SqlWindowTableFunction|RexImpTable.get|translateTableFunction'
javap -c -p -classpath "$jar" \
    'org.apache.calcite.adapter.enumerable.RexImpTable$TumbleImplementor' \
    'org.apache.calcite.adapter.enumerable.RexImpTable$HopImplementor' |
    rg 'class .*Implementor|Expression implement|BuiltInMethod.(TUMBLING|HOPPING)'
