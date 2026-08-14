/**
 * The account, as the client is allowed to see it.
 *
 * There were two of these, in auth.ts and account.ts, and they had already
 * drifted: the auth copy did not send `currency`, so a workspace set to dollars
 * was handed back as rand on every login and page refresh, and the whole app
 * silently fell back to its default. Nothing in the types could catch that, since
 * both objects were valid on their own.
 *
 * One definition means the two paths cannot disagree again. Anything added here
 * has to be safe for any member of the workspace to see.
 */
export function publicAccount(a) {
    return {
        id: a.id, name: a.name, slug: a.slug, plan: a.plan,
        folderLabelSingular: a.folderLabelSingular, folderLabelPlural: a.folderLabelPlural,
        brandName: a.brandName, hasLogo: !!a.logoPath, currency: a.currency,
    };
}
//# sourceMappingURL=publicAccount.js.map