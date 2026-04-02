# Query sessions

Synapsd is primarily used as a backend for natural language queries processed on the application level. 
I'm thinking about implementing the following "session-like" feature and I'm not sure whether its a good idea:

- Consumer creates a session with an optional query and gets a session ID with optional results(ids, meta or full)
- A session would be kept in memory until explicitly destroyed(later on we can implement some TTL based mechanism, we'd probably cap maxSessions)
- Session object would have the following methods:
    - addPaths
    - removePaths
    - listPaths
    - addFeatures
    - removeFeatures
    - listFeatures
    - addFilters
    - removeFilters
    - listFilters    
    - getIds() - gets the current list of Ids 
    - getMetadata() - gets metadata for all found documents
    - getDocuments() - gets the full documents
    - query() - runs a ranked natural language query on top of all documents within the session
    - refresh() - documents may change during a long-lived session


