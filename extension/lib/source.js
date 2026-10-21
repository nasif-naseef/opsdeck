// SPDX-License-Identifier: MIT

/**
 * A failure a source wants to show to the user, as opposed to a bug.
 * `kind` lets views pick an appropriate empty state.
 */
export class SourceError extends Error {
    /**
     * @param {string} kind - e.g. 'missing', 'daemon', 'permission', 'signed-out'
     * @param {string} message - short, user-facing
     * @param {string} [hint] - optional next step for the user
     */
    constructor(kind, message, hint = '') {
        super(message);
        this.name = 'SourceError';
        this.kind = kind;
        this.hint = hint;
    }
}

/** Result of a user-triggered action (kill, stop, ...). */
export function actionResult(ok, message = '') {
    return {ok, message};
}
