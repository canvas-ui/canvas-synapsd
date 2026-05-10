# Timeline(v2) implementation

## Goals

- Index arbitrary datetimes/timestamps - from incoming files, browser tabs, emails and messages to geological timescales extracted from indexed content(news articles, wikipedia or internal knowledge repos, notes, personal diaries etc)
- Range theoretically (-∞, ∞), realistically ~age of the universe, we'd probably get way with a 128 or even 64bit address space even if some users would want to index thousand events/s from different sources(that one guy who'll pipe his rsyslog/fluentd collected events into our app)
- Timeline should support intervals, <close,close>/<close,open)/(open,close> - think "communism", "middle-ages", "paleozoic era", "trip to Spain"

- Timelines should be composable, meaning, we should be able to use multiple timelines but internally keep them separate and selectable on-demand (lets say a internal family timeline overlayed on top of the wikipedia timeline and a timeline extracted from some memoirs of person foo:
  - wikipedia.timeline
  - family.timeline
  - historian_x.timeline
  - person_foo.timeline
  - scientific_revolutions.timeline

- From a users/applications perspective, querying for a specific date should return multiple layers of data I can visualize based on a desired scope/dynamically generated/extracted semantic "anchors" used in the semantic layer of the database for further filtering(not a concern of the timeline module per-se, this is a task for the semantic layer of the database)
  - A good example not directly related to incoming emails or browser tabs: A query for year "1720" of timeline "wikipedia" and "random historian" should return
  - Exact events - which people were born, what events happend or were happening during that time
  - what periods are overloapping that point in time in literature, music, science, philosophy(all anchor points) - iow what was the zeitgeist for that particular time, BUT with the option to focus on specific aspects - like the overlap between literature and science in Newtons "clockwork universe" era - with the option to use several timelines

## Notes

- we do not need ns resolution for geological eras, not even for emails and most of the indexed events, we should use some clever hierarchical/prefix-based index to allow "zoom" into "second" precision only if that level of detail is required

- bitmaps were never intended to be a panacea for indexing user data, even though I still think hierarchical layered bitmaps that map to documents (or document-based indexes pointing to real data locations) for the last-mile exact queries are a design win. For agentic workloads and continual recall with natural language anchors, we need a fuzzy/weighted context aware frontend(maybe even using something exotic as a lossy compression algo projecting a q - or better put, contextualy evaluated parts of a q(that came from a background single-purpose distilled model "loops" hydrating a shared in-memory context in the agent runtime) - into a limited set of exact semantic activation bitmap indexes; retrieval of the actual full documents/document chunks should be rather sporadic and only needed for specific queries ("give me all invoices for foo from last month" vs "do we have any new emails for project foo" - the latter one should be completely answered by the upper semantic layers, querying the exact numbers or content of emails on-demand)

- Extracted semantic anchors need to be fuzzy enough to work cross-timelines, humans :) and llm models, and probably layered/"multi-colored"(its layers and loops all the way down!), ad-hoc examples, not a timeline topic, need more thinking time 
  - finance
    - income
    - investment
    - ..
  - family
  - work
  - physics
  - urgent
  - historical
  - personal


## Architecture options(need eval/triage)

### Basic building blocks/primitives to eval

- Interval Tree / Segment Tree / quadtrees / octrees / UB-trees
- Z-order curves
- EDTFs
- Hierarchical Adaptive Bucketing epoch/year/month/day/hour/minute
- Roaring Bitmaps / Hierarchical bitmap pyramids
Universe
 ├── billion years
 │    ├── million years
 │    │    ├── thousand years
 │    │    │    ├── years
 │    │    │    │    ├── days


### Genomic interval indexing

### GIS spatial indexing

S2 Geometry Library / S2 Cell IDs / geohashes 
- 1D instead of spherical
  - Morton codes?Hilbert curves
- temporal instead of spatial
T/
 ├── era
 ├── century
 ├── decade
 ├── year
 ├── month
 ├── day
 ├── hour
 ├── minute
 └── second


## References

Building blocks:
- https://www.npmjs.com/package/node-interval-tree
- https://www.npmjs.com/package/@flatten-js/interval-tree

