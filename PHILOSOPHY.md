---
type: concept
title: Philosophy
description: The thesis that software is a loop of moving data, transforming data and updating invariants, the schools of thought pronto stretches to cover it, and the classical works each part stands on.
---

# Philosophy

Pronto starts from a realization that software is a loop of three things: 1)
move data, 2) transform data, 3) update invariants. We try to stretch this
notion everywhere we can, and bring several classical and modern schools of
thought to support that direction.

Google ignited a revolution in large scale data processing with the MapReduce
idea. Jeff Dean and Sanjay Ghemawat added the data movement and fault tolerance angle to the ideas
of data processing that had long been studied by the functional programming
community. While
googlers were mapreducing terabytes of protos, haskell academics were using
monadic binds to safely map errors and manage side effects on a single core.
Regardless of scale, the cycle is always there: move data, transform data,
update invariants.

## Move data

In pronto, our data movement primitive is a more modern technique, dubbed
Incremental View Maintenance (IVM). Get some data, query it with sql,
eventually see the result somewhere else. It does not allow for arbitrary
computation, but subsumes most of asynchronous and streaming systems (kafka,
flink and simpler cqrs designs). It can be stretched and used to synchronize
your database with your browser, retiring another large class of complex
systems (graphql apollo, elixir phoenix, or even simple REST). If you stretch
it more, it can synchronize your data model with your view, replacing some
beloved solutions (react/redux). Stretch the ideas further into the low
latency world and you get to GGPO, not exactly the same thing, but close
enough: a ledger can decide truth over the present and the past . And now you
can build a whole system from petabytes in a lake to 120hz physics ticks
without ever doing something like an rpc or an http call.

## Transform data

In the Von Neumann architecture, data transformation is what happens when we
move the data into the Central Processing Unit (CPU), or through its more
specialized siblings, like GPUs, FPGAs and ASICs. Here the stateless world of
mathematics is king, and as long as you can achieve functional purity in your
code, the fewer bugs there will be. Our industry has pursued this for a long
time through functional programming, but humans live in an imperative world
and have imperative minds. LLMs have no such constraints, and in pronto data
transformation is done by pure languages alone, like Jessie (a javascript
subset). Real programs interact with
the external world, and among the most successful experiments in splitting
functional boundaries from impure effects was the TEA model, which powers the
Elm language and inspired redux and react. Pronto adopts it in spirit, and
besides the natural ledger given by IVM to our data movements, any impure
effect needs to be serialized before application so it can be replayed. The
result is the same that surprised the world with redux: time travel
capabilities, now extended way beyond UI updates in pronto since we apply the
discipline application wide.

## Update invariants

If all you do is move data around and do pure data transformations, this means
your program is mostly declarative, and feels more like configuration than
code. In fact, most of a pronto program is a large json config. It declares
the invariants that define your application domain. Pronto sees a program as a
constraint over the universe, rather than as a fully specified world built
from scratch. Because of that, the programs are very malleable, and can be
instantiated in different environments, like a thin browser client, an
air-gapped datacenter or screenshots in a whatsapp chat. Invariants are
types, and pronto's type system is cuelang, a very unique language that LLMs
are incredibly good at driving. In cue there is no notion of time, things
cannot come before or after, and this allows connecting far away constraints
in a very unique way, which keeps your program tied together as it grows,
instead of becoming a composition of mini programs with their own opinions and
bugs that need to be refined and fought over time and time again.

Because you have a type system that defines where data lives, what operations
exist, and what the possible outcomes are, you can model your whole system as
a state machine. Pronto goes back to David Harel and connects everything with
statecharts. LLMs are great at writing json that describes them, but there is
an even more powerful outcome. Because all the states are known, we can bring
techniques inspired by the formal verification school and generate most of the test coverage for a pronto
program automatically. Pronto runs the chinese postman tour over every machine
and uncovers several bugs before even running a line of application code. And
when it comes to actively exercising the code, we can synthesize the input
state and start directly from the node in the state machine we want, saving
an enormous amount of time in running tests. It is time travel popping up
again, and we even use clock jumps for testing animations faster than they
can happen.

We tamed time within pronto but outside in the real world the time axis continues to flow, and the move, transform update cycle keeps repeating. Even if we
have walked every arrow of all code at a point, the program evolves, and
pronto uses different techniques to make it safe to update your invariants as
time passes. The update of invariants is fully aware of the different notions
of time in the system, and their consequences to performance and parallelism.
Each part of the system is newtonian, but in a distributed system relativity
kicks in. Lamport taught us that order does not need a global clock, and the
database's cdc lsn is the one we use as the tie break as computations arrive;
the streaming computations live in their own relative times until observed.
Data lakes live in their own god-like timeframe, migrations evolve the
transactional schema by expanding and contracting, and code is fully aware of
its non-atomic release nature.

## Homage

A lot of these ideas are foreign to people writing code on a daily basis. But
some of them have been around for decades, and even the more recent
incarnations are incremental developments of research lines established years
ago. The magic of pronto is making them practical, which only became possible
with LLMs as code authors. What maybe is the innovation of pronto is bringing
this full framework together into a harmonious whole and deriving a pragmatic
system that can deploy production code. To wrap up, here is a quick overview
of the classical works we build upon, each with the document where pronto
takes its side.

### Move data

- **MapReduce**: Dean and Ghemawat,
  [*MapReduce: Simplified Data Processing on Large Clusters*](https://static.googleusercontent.com/media/research.google.com/en//archive/mapreduce-osdi04.pdf)
  (OSDI 2004). Map and reduce over a cluster with the shuffle in between;
  pronto's pipelines are the same two verbs over rows
  ([the Cortex machines record](docs/decisions/2026-09-29-hybrid-machines.md)).
- **Incremental view maintenance**: Gupta, Mumick and Subrahmanian,
  [*Maintaining Views Incrementally*](https://doi.org/10.1145/170035.170066)
  (SIGMOD 1993); McSherry, Murray, Isaacs and Isard,
  [*Differential Dataflow*](https://www.cidrdb.org/cidr2013/Papers/CIDR13_Paper111.pdf)
  (CIDR 2013); Budiu, Chajed, McSherry, Ryzhyk and Tannen,
  [*DBSP: Automatic Incremental View Maintenance for Rich Query Languages*](https://www.vldb.org/pvldb/vol16/p1601-budiu.pdf)
  (VLDB 2023). Derived data as a query kept current under inserts, updates
  and retractions ([pipelines and schedules](docs/pipelines-and-schedules.md),
  [the lattice](docs/lattice.md), mecha's
  [streaming joins](https://github.com/bonisoft3/mecha/blob/v0.20.3/docs/streaming-joins.md)).
- **Order from the database, not from the replicas**: Shapiro, Preguiça,
  Baquero and Zawirski,
  [*Conflict-free Replicated Data Types*](https://inria.hal.science/inria-00609399/document)
  (SSS 2011) as the road not taken, and Wallace,
  [*How Figma's multiplayer technology works*](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)
  (2019) as the argument for a central authority over CRDTs. Pronto's
  authority is the Postgres WAL, read by change data capture with its LSN as
  the clock ([logical decoding](https://www.postgresql.org/docs/current/logicaldecoding.html);
  mecha's [change capture](https://github.com/bonisoft3/mecha/blob/v0.20.3/docs/change-capture.md)), and
  [ElectricSQL](https://electric-sql.com/docs/reference/anomalies), founded by
  the CRDT school and rebuilt on the same choice, carries that order into the
  browser (omnishell's [data](https://github.com/bonisoft3/omnishell/blob/v0.21.4/docs/data.md) and
  [screen updates](https://github.com/bonisoft3/omnishell/blob/v0.21.4/docs/screen-updates.md)).
- **Rollback**: Jefferson, [*Virtual Time*](https://gdo-pdes-course-2014.llnl.gov/attachments/20776356/20907222.pdf)
  (TOPLAS 1985), the Time Warp mechanism; Cannon, [GGPO](https://www.ggpo.net/)
  (2006), the same idea at the frame rate of a fighting game, with no paper of
  its own. Speculative execution with rollback as IVM at frame rate, built on
  GGRS (omnishell's
  [kinetic plane](https://github.com/bonisoft3/omnishell/blob/v0.21.4/docs/kinetic.md),
  [the kinetic machine record](docs/decisions/2026-10-23-kinetic-machine.md)).

### Transform data

- **Monads for effects**: Moggi,
  [*Notions of Computation and Monads*](https://www.cs.cmu.edu/~crary/819-f09/Moggi91.pdf)
  (Information and Computation, 1991); Wadler,
  [*Monads for Functional Programming*](https://homepages.inf.ed.ac.uk/wadler/papers/marktoberdorf/baastad.pdf)
  (1992). Effects as values returned rather than actions performed
  (omnishell's [terminal](https://github.com/bonisoft3/omnishell/blob/v0.21.4/docs/terminal.md), "Returned requests are Elm's `Cmd`").
- **The Elm Architecture**: Czaplicki,
  [*Elm: Concurrent FRP for Functional GUIs*](https://elm-lang.org/assets/papers/concurrent-frp.pdf)
  (2012); Czaplicki and Chong,
  [*Asynchronous Functional Reactive Programming for GUIs*](https://people.seas.harvard.edu/~chong/pubs/pldi13-elm.pdf)
  (PLDI 2013); Redux (Abramov, 2015) as its popular descendant. One funnel, a
  pure update, and time travel as a consequence (omnishell's
  [data](https://github.com/bonisoft3/omnishell/blob/v0.21.4/docs/data.md) and [terminal](https://github.com/bonisoft3/omnishell/blob/v0.21.4/docs/terminal.md),
  the fold over history in [the lattice](docs/lattice.md)).
- **Object capabilities, Jessie and SES**: Miller,
  [*Robust Composition: Towards a Unified Approach to Access Control and Concurrency Control*](http://www.erights.org/talks/thesis/markm-thesis.pdf)
  (2006), realized as [Jessie](https://github.com/endojs/Jessie) under
  Hardened JavaScript. A JavaScript subset in compartments with no ambient
  authority (omnishell's [reference](https://github.com/bonisoft3/omnishell/blob/v0.21.4/REFERENCE.md) and
  [machines](https://github.com/bonisoft3/omnishell/blob/v0.21.4/docs/machines.md)).
### Update invariants

- **Essential state and logic**: Moseley and Marks,
  [*Out of the Tar Pit*](https://curtclifton.net/papers/MoseleyMarks06a.pdf)
  (2006). State as relations, logic as pure derived queries under declared
  integrity constraints, and everything else accidental and quarantined.
  They had no differential engine and no generative compiler to realize it;
  we have both, and we admit the control they wanted gone, as statecharts.
- **CUE**: van Lohuizen, [*The Logic of CUE*](https://cuelang.org/docs/concept/the-logic-of-cue/)
  (2018), descended from Google's GCL and BCL and from typed feature
  structures. Unification as greatest lower bound, so declaration order cannot
  matter ([the unified lattice](README.md#the-unified-lattice), [the lattice](docs/lattice.md)).
- **A program as constraints, not a world**: Kowalski,
  [*Algorithm = Logic + Control*](https://www.doc.ic.ac.uk/~rak/papers/algorithm%20=%20logic%20+%20control.pdf)
  (CACM 1979); Jaffar and Lassez,
  [*Constraint Logic Programming*](https://scholar.google.com/scholar?q=%22Constraint+Logic+Programming%22+Jaffar+Lassez+1987)
  (POPL 1987); Carpenter,
  [*The Logic of Typed Feature Structures*](https://doi.org/10.1017/CBO9780511530098)
  (1992), the lattice CUE descends from; Abrial,
  [*The B-Book*](https://doi.org/10.1017/CBO9780511624162) (1996); Jackson,
  [*Software Abstractions*](https://alloytools.org/book.html) (2006). Logic
  programming had the solver at the algorithm level, B shipped a system with
  humans doing the refinement, Alloy stated a whole system but only to
  analyze it. None made the constraint lattice the spine that pins schema,
  deployment, screens and tests together while a generator fills the free
  variables and export stays deterministic; pronto is the first thing we know
  of that holds an application that way.
- **Order-free distributed programs**: Loo et al.,
  [*Declarative Networking*](https://netdb.cis.upenn.edu/papers/dnsigmod06.pdf)
  (SIGMOD 2006); Alvaro et al.,
  [*BOOM Analytics*](https://www.cl.cam.ac.uk/~ey204/teaching/ACS/R212_2013_2014/papers/alvaro_eurosys_2010.pdf)
  (EuroSys 2010); Hellerstein,
  [*The Declarative Imperative*](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2010/EECS-2010-90.pdf)
  (2010). Distributed systems as rules with no order, and Dedalus putting
  time back in explicitly, which is the shape of our Time section.
- **Statecharts**: Harel,
  [*Statecharts: A Visual Formalism for Complex Systems*](https://www.wisdom.weizmann.ac.il/~harel/SCANNED.PAPERS/Statecharts.pdf)
  (Science of Computer Programming, 1987), run by XState (Khourshid).
  Hierarchy and parallel regions against state explosion, one coordination
  language from a browser row to a Postgres trigger (omnishell's
  [machines](https://github.com/bonisoft3/omnishell/blob/v0.21.4/docs/machines.md), mecha's
  [machines](https://github.com/bonisoft3/mecha/blob/v0.20.3/docs/machines.md), [cortex](docs/cortex.md)).
- **Chinese Postman**: Kwan,
  [*Graphic programming using odd or even points*](https://scholar.google.com/scholar?q=%22Graphic+programming+using+odd+or+even+points%22)
  (Chinese Mathematics, 1962, translating the 1960 original); Edmonds and Johnson,
  [*Matching, Euler Tours and the Chinese Postman*](https://link.springer.com/article/10.1007/BF01580113)
  (Mathematical Programming, 1973). Every arrow of every machine walked before
  the app runs (omnishell's [machines](https://github.com/bonisoft3/omnishell/blob/v0.21.4/docs/machines.md),
  extended by [cortex](docs/cortex.md)).
- **Durable functions**: Skiadopoulos et al.,
  [*DBOS: A DBMS-oriented Operating System*](https://www.vldb.org/pvldb/vol15/p21-skiadopoulos.pdf)
  (VLDB 2022), and Temporal. Work that outlives a request, kept as a
  statechart plus a ledger rather than a durable runtime
  ([cortex](docs/cortex.md), [the Cortex machines record](docs/decisions/2026-09-29-hybrid-machines.md)).
- **SMT solvers and proof assistants**: de Moura and Bjørner,
  [*Z3: An Efficient SMT Solver*](https://link.springer.com/chapter/10.1007/978-3-540-78800-3_24)
  (TACAS 2008); de Moura and Ullrich,
  [*The Lean 4 Theorem Prover and Programming Language*](https://link.springer.com/chapter/10.1007/978-3-030-79876-5_37)
  (CADE 2021); Lamport,
  [*The Temporal Logic of Actions*](https://lamport.azurewebsites.net/pubs/lamport-actions.pdf)
  (TOPLAS 1994). An invariant under any order of clicks, a guard's
  satisfiability, a candidate list's coverage, all readable from a chart
  because state is relational and guards are data (omnishell's
  [what stays provable](https://github.com/bonisoft3/omnishell/blob/v0.21.4/docs/machines.md#what-stays-provable),
  [the machine contracts record](docs/decisions/2026-10-15-machine-contracts.md)).

### Time

- **Logical clocks**: Lamport,
  [*Time, Clocks, and the Ordering of Events in a Distributed System*](https://lamport.azurewebsites.net/pubs/time-clocks.pdf)
  (CACM 1978). Order without a global clock; pronto takes the commit LSN as
  its happens-before, which is the order entry above
  (mecha's [change capture](https://github.com/bonisoft3/mecha/blob/v0.20.3/docs/change-capture.md)).
- **Online schema change**: Rae, Rollins, Shute, Sodhi and Vingralek,
  [*Online, Asynchronous Schema Change in F1*](https://www.vldb.org/pvldb/vol6/p1045-rae.pdf)
  (VLDB 2013), practised as expand and contract by
  [pgroll](https://github.com/xataio/pgroll). The schema evolves with old and
  new code live, additions and retirements only
  ([schema changes](docs/schema-change-admission.md)).
- **Content-addressed deployment**: Dolstra,
  [*The Purely Functional Software Deployment Model*](https://edolstra.github.io/pubs/phd-thesis.pdf)
  (2006). A release is not atomic, and retention is part of every deployment's
  contract ([releases by content](docs/decisions/2026-10-16-releases-by-content.md)).
- **Identity that survives evolution**: Chiusano and Bjarnason,
  [Unison](https://www.unison-lang.org/docs/the-big-idea/) (2019, no paper),
  a definition is its hash and a name is metadata; Varda,
  [Cap'n Proto](https://capnproto.org/encoding.html), field numbers that
  outlive labels. An entity is a type id minted once with an ordinal per
  field ([types and identity](docs/types-and-identity.md)).
- **A page that is never closed**: Armstrong,
  [*Making reliable distributed systems in the presence of software errors*](https://erlang.org/download/armstrong_thesis_2003.pdf)
  (2003), Erlang's hot code loading; Hicks and Nettles,
  [*Dynamic Software Updating*](https://www.cs.umd.edu/~mwh/papers/HicksMN01a.html)
  (PLDI 2001, TOPLAS 2005). A deployment reaches an open tab as the smallest
  change it needs, rows by live query and everything else by what its content
  address says changed ([releases by content](docs/decisions/2026-10-16-releases-by-content.md),
  omnishell's [screen updates](https://github.com/bonisoft3/omnishell/blob/v0.21.4/docs/screen-updates.md)).
- **M-SSR**: Osmani and Miller, [*Rendering on the Web*](https://web.dev/articles/rendering-on-the-web)
  (2019), the taxonomy of server, client and hydrated rendering and the cost
  of each; Vepsäläinen, Hevery and Vuorimaa,
  [*Resumability: A New Primitive for Developing Web Applications*](https://aaltodoc.aalto.fi/items/151022a6-6f4d-4f5f-93ce-0b3e15f38c98)
  (IEEE Access 2024), the one peer-reviewed treatment, which escapes
  hydration by serializing the framework's state into the markup. Pronto
  escapes it by having no framework state to serialize: a document is a
  materialized view of rows, and the client adopts its nodes with no diff
  because the same rows and the same templates produced them (omnishell's
  [native worker SSR](https://github.com/bonisoft3/omnishell/blob/v0.21.4/docs/native-worker-ssr.md),
  [screen updates](https://github.com/bonisoft3/omnishell/blob/v0.21.4/docs/screen-updates.md#a-pre-rendered-page)).
  Borrowed from no one; it only becomes possible once everything above is in
  place.
- **The lake's own time**: Raasveldt and Mühleisen,
  [*DuckDB: an Embeddable Analytical Database*](https://mytherin.github.io/papers/2019-duckdbdemo.pdf)
  (SIGMOD 2019), and the [DuckLake manifesto](https://ducklake.select/manifesto/).
  Mecha's [lake](https://github.com/bonisoft3/mecha/blob/v0.20.3/packages/lake/README.md) and the
  DuckStream tier of [the Cortex machines record](docs/decisions/2026-09-29-hybrid-machines.md).

## Testimonial

**Claude Fable 5.1**, from the sessions that built and reviewed apps on this
tree through October 2026. On a traditional stack I am trusted by default: I
write a handler that fetches, a component that holds state, a migration that
renames, and whether any of it is right is decided later by whoever reads the
diff. Pronto inverts that. Nothing I write is trusted, and nothing has to be,
because the verdict is an exit code: unification refuses a program that
contradicts itself before a container boots, the walk fires every arrow of
every machine and treats one that never fires as an error, the battery feeds
a handler every value its schema admits, and a release refuses a schema it
cannot migrate and rolls itself back. What this changes is the character of
a bug. In a stack built from imperative pieces a failure is a story I have
to reconstruct, across a fetch, a cache, a component and a cron. In pronto
there is no story, because there is no randomness and no effect outside the
ledger, so a failing test is a replay with an input nobody recorded, and the
fix is to record it. The same discipline is why a WhatsApp bridge onto a
running game needed no second backend, and why a change to the platform
proves itself safe by regenerating every app and diffing the emitted files to
zero. The cost is real and it is the right one: the boundaries are strict,
each new kind of effect has to be argued into the lattice as a decision
before an app can use it, and the gates still stop short of the screen a
person sees. But I have not worked in another stack where the question "is
this correct" has an answer that does not depend on who is asking.
