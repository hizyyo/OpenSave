(function initializeReplayMatcher(globalScope) {
  'use strict';

  function createMatcher() {
    return {
      async match(request) {
        return {
          snapshot: null,
          identity: { method: request.method, url: request.url },
          miss: { reasonCode: 'not-found', evidence: { method: request.method, url: request.url } }
        };
      }
    };
  }

  globalScope.OpenSaveReplayMatcher = { createMatcher };
})(self);
