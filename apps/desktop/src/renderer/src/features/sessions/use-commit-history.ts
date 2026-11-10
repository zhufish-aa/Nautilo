import {useEffect, useRef, useState} from "react";
import type {SourceControlHistoryPage, SourceControlRepository, SourceControlScope} from "@agenthub/schemas";
import {requestCore} from "../../lib/bridge";

interface HistoryList {
  query: string;
  page?: SourceControlHistoryPage;
  error?: string;
  loadingMore?: boolean;
}

export function useCommitHistory(repository: SourceControlRepository, scope: SourceControlScope, paged: boolean, zh: boolean, initialSearch="") {
  const [search, setSearch] = useState(initialSearch);
  const [revision, setRevision] = useState(0);
  const [list, setList] = useState<HistoryList>({query: ""});
  const generation = useRef(0);
  const loadingMore = useRef(false);
  const query = search.trim();
  const {rootPath} = repository;
  const {sessionId, projectId} = scope;
  const mismatch = zh ? "仓库或搜索条件已改变，请刷新。" : "Repository or search changed. Refresh to retry.";

  function checkPage(page: SourceControlHistoryPage) {
    const expectedRef = repository.detached ? "HEAD" : "refs/heads/" + repository.branch;
    if (page.rootPath !== rootPath || page.query !== query || page.reference !== expectedRef ||
        (repository.detached && page.currentHead !== repository.head)) throw new Error(mismatch);
    return page;
  }

  useEffect(() => {
    const request = ++generation.current;
    loadingMore.current = false;
    if (!paged) return;
    setList({query});
    const timer = window.setTimeout(() => {
      void requestCore<SourceControlHistoryPage>("scm.history", {sessionId, projectId, query})
        .then(checkPage)
        .then(page => { if (generation.current === request) setList({query, page}); })
        .catch(error => { if (generation.current === request) setList({query, error: String(error)}); });
    }, query ? 250 : 0);
    return () => { ++generation.current; window.clearTimeout(timer); };
  }, [sessionId, projectId, rootPath, paged, query, revision]);

  const page = paged && list.query === query ? list.page : undefined;
  async function loadMore() {
    if (!page?.nextCursor || loadingMore.current) return;
    loadingMore.current = true;
    const request = generation.current;
    setList({query, page, loadingMore: true});
    try {
      const next = checkPage(await requestCore<SourceControlHistoryPage>("scm.history", {sessionId, projectId, query, cursor: page.nextCursor}));
      if (request !== generation.current) return;
      if (next.head !== page.head) throw new Error(mismatch);
      const seen = new Set(page.items.map(item => item.hash));
      const items = [...page.items, ...next.items.filter(item => !seen.has(item.hash))];
      setList({query, page: {...next, items}});
    } catch (error) {
      if (request === generation.current) setList({query, page, error: String(error)});
    } finally {
      if (request === generation.current) loadingMore.current = false;
    }
  }

  const error = paged && list.query === query ? list.error : undefined;
  return {
    search, setSearch, items: paged ? page?.items ?? [] : repository.recent,
    loading: paged && !page && !error, error,
    hasMore: !!page?.nextCursor, loadingMore: !!list.loadingMore,
    changed: !!page && (page.head !== repository.head || page.head !== page.currentHead),
    loadMore, refresh: () => setRevision(value => value + 1),
  };
}
