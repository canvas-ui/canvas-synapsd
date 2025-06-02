# TODO

- ! Implement pagination on top of range queries
- ! Implement a off-thread worker to post-process ingested documents (to calculate embeddings, tag bitmaps etc)
- ! Create a *proper* collection abstraction, esp. for Bitmaps
- ! Refactor those ***UGLY*** insert/updateDocument methods!!!
- format option
  - full
  - data+meta (data)
  - meta
- Add zod validators to internal schemas
- Add zod-to-json (zod v4) schema support
- Besides standard document abstractions, we need to support Canvases and Workspaces, most probably we should remove them from internal or create a proper document abstraction for this type, anyway, todo, lets finally focus on a *usable* mvp damn it!!

## To eval

- Integrate storeD, we want to be able to store documents in different locations while keeping a simple SPOT index what is stored where and from what location it is reachable. This would allow us to store data in different formats - lets say using a simple file backend for on-disk storage as markdown text files
- We want to support dynamic (statefull) vector-store-powered retrieval. Lets say we want to recall some documents about the year 1776, we have our main context (context Tree) with bitmaps we can use to pre-filter our result document IDs(in this context, bitmaps start to become beneficial for very large datasets) - before we hit our vector store.  
  
  We should start a query transaction and dynamically update the tree/bitmap arrays based on retrieved document metadata we received which should stay cached in-memory for the duration of that transaction. But more importantly, we should be able to refine which snippets/keywords/factoids we want to focus on dynamically - this means that instead of chunking up the whole document to calculate embedding vectors, we'd first process it to generate specific topics/tags/factoids/concepts, calculate and store embeddings of those, parse our query into the same and do a vector-db similarity search. Once a batch of documents is retrieved - as metadata - we can further refine the query (dive "deeper" into the memory) by silencing/removing/reorganizing items in the factoid/concept array (while optionally - simultaneously updating our context tree/bitmap refs) and update the resulting document metadata array. We can then retrieve the top N documents in full with the rest of as metadata only. Should be fairly simple to test:
  - Ingestion pipeline that would off-thread process documents, we need to do this anyway for things like browser tabs (I'd like to download a ofline copy and process it for RAG whenever a tab gets inserted), same for notes, emails etc
    - Pipeline would first fetch the linked content if applicable
    - Extract concepts, factoids, tags from the data and store them in the metadata part of the document(we will need to update our schemas a little), not used directly but will be useful when using different embedding models
    - Calculate embeddings for all data and store them in a vector DB(not sure it'd make sense to store them in the document object itself, we support embeddings directly for use-cases like file indexing where the client itself would calculate embeddings)
  
