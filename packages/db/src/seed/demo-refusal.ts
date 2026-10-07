/**
 * THE DEMO DAY SAYING NO (SCRUM-503).
 *
 * The demo control on Console > Health refuses before it writes the day's
 * sales when the deployment is not in a state it can add a day to (the demo
 * branch and the frozen legacy days, each made once, may already stand by
 * then, as they would after any press): a code prefix another
 * booth already prints under, a demo booth the Console left without a wheel,
 * a park the seed has not built yet. Each of those is a sentence a person can
 * act on, and the api answers it as the refusal it is — a 409 in the api's
 * error shape, carrying these words — rather than as a server fault whose
 * words nobody sees.
 *
 * A fault is still a plain `Error`: a code that cannot be minted after every
 * draw, a receipt number that cannot be allocated, a scenario written wrong.
 */
export class DemoDayRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoDayRefusedError';
  }
}
