/**
 * Ready-made boards.
 *
 * The same handful of processes turn up in every business: onboarding a client,
 * running a piece of work to delivery, closing off a month, hiring someone. People
 * rebuild them by hand each time and each rebuild forgets a step. These are the
 * steps, already written down, ready to drop into any folder.
 *
 * Declarative on purpose, like the business blueprints: adding one is a few lines
 * here and nothing else. Cards carry no dates or assignees, because a template is
 * the shape of the work rather than a particular run of it.
 */
const TODO_DOING_DONE = [
    { name: 'To do', color: '#94a3b8' },
    { name: 'Doing', color: '#3b82f6' },
    { name: 'Done', color: '#22c55e', isDoneColumn: true },
];
export const BOARD_TEMPLATES = [
    {
        key: 'client-onboarding',
        label: 'Client onboarding',
        blurb: 'From signed to started, without the usual scramble.',
        cards: [
            { title: 'Send the welcome email and what happens next', description: 'Set the tone and the expectations in one message.' },
            { title: 'Collect what you need to start', description: 'Logins, brand files, access, the brief. Ask once, in a list.' },
            { title: 'Book the kickoff call' },
            { title: 'Agree the deadline and the definition of done' },
            { title: 'Set up their folder, board and billing details in Klippy' },
            { title: 'Send the deposit invoice' },
        ],
    },
    {
        key: 'delivery-run',
        label: 'Delivery run',
        blurb: 'The same run of work for every client, so nothing gets skipped.',
        cards: [
            { title: 'Kickoff call and written brief', description: 'Agree the outcome, the deadline, and what you need from them.' },
            { title: 'Do the work' },
            { title: 'Internal check before it goes out', description: 'Read it as the client would. Fix the obvious things first.' },
            { title: 'Review with the client' },
            { title: 'Apply the feedback' },
            { title: 'Deliver and invoice' },
            { title: 'Ask for a testimonial and a referral', description: 'The easiest sale you will make is to someone referred by a person who just got a result.' },
        ],
    },
    {
        key: 'month-end',
        label: 'Month end',
        blurb: 'The finance admin that gets forgotten until it is late.',
        cards: [
            { title: 'Raise any invoices not yet sent' },
            { title: 'Chase everything overdue', description: 'Collections shows who owes what, worst first.' },
            { title: 'Log the month of expenses' },
            { title: 'Reconcile the bank against Klippy' },
            { title: 'Put money aside for tax' },
            { title: 'Fifteen minutes on the numbers', description: 'What came in, what shipped, what it cost, what that says about next month.' },
        ],
    },
    {
        key: 'new-client-pitch',
        label: 'Pitch and proposal',
        blurb: 'Turning an interested lead into a signed deal.',
        columns: [
            { name: 'To prepare', color: '#94a3b8' },
            { name: 'With them', color: '#3b82f6' },
            { name: 'Decided', color: '#22c55e', isDoneColumn: true },
        ],
        cards: [
            { title: 'Research them properly', description: 'What they sell, who to, and what is visibly not working.' },
            { title: 'Discovery call', description: 'Ask what it costs them today. That number is your price anchor.' },
            { title: 'Write the proposal' },
            { title: 'Send it and book the walkthrough', description: 'A proposal emailed without a call booked is a proposal that goes quiet.' },
            { title: 'Follow up', column: 1 },
            { title: 'Close, or find out why not', column: 1 },
        ],
    },
    {
        key: 'content-calendar',
        label: 'Content calendar',
        blurb: 'From idea to published, one lane per stage.',
        columns: [
            { name: 'Ideas', color: '#94a3b8' },
            { name: 'Writing', color: '#3b82f6' },
            { name: 'Editing', color: '#a855f7' },
            { name: 'Scheduled', color: '#f59e0b' },
            { name: 'Published', color: '#22c55e', isDoneColumn: true },
        ],
        cards: [
            { title: 'Keep a running list of ideas', description: 'Anything a client asked you is a piece of content.' },
            { title: 'Plan the month' },
            { title: 'Write the first piece', column: 1 },
            { title: 'Repurpose what did well', column: 0, description: 'One good piece is five posts, an email and a video.' },
        ],
    },
    {
        key: 'hiring',
        label: 'Hiring',
        blurb: 'Running a role without losing candidates in the gaps.',
        columns: [
            { name: 'Applied', color: '#94a3b8' },
            { name: 'Screening', color: '#3b82f6' },
            { name: 'Interview', color: '#a855f7' },
            { name: 'Offer', color: '#f59e0b' },
            { name: 'Closed', color: '#22c55e', isDoneColumn: true },
        ],
        cards: [
            { title: 'Write the role and what good looks like', description: 'Be specific about the outcome, not the years of experience.' },
            { title: 'Post it where the right people are' },
            { title: 'Set the screening questions', column: 1 },
            { title: 'Prepare a paid trial task', column: 2, description: 'A small real task tells you more than an hour of talking.' },
            { title: 'Reply to everyone, including the no', column: 4, description: 'Cheap to do, and people remember it.' },
        ],
    },
];
const BY_KEY = new Map(BOARD_TEMPLATES.map((t) => [t.key, t]));
export const boardTemplate = (key) => BY_KEY.get(key);
/** Columns for a template, defaulting to the ordinary three. */
export const columnsFor = (t) => t.columns ?? TODO_DOING_DONE;
//# sourceMappingURL=boardTemplates.js.map