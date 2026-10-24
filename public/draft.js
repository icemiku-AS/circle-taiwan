// A full snapshot repairs a missing base after reconnecting.
export class DraftSync {
  reset(question, revision, points) { this.question = question; this.revision = revision; this.points = points; this.full = true; }
  ack(value) { if ((!value.questionId || value.questionId === this.question) && value.resync) this.full = true; }
  message(points, revision, full = false) {
    const previous = this.points || [];
    const appended = points.length >= previous.length && previous.every((p, i) => p[0] === points[i][0] && p[1] === points[i][1]);
    if (!full && !this.full && appended && points.length === previous.length) return null;
    const value = !full && !this.full && appended ? { baseRevision: this.revision, append: points.slice(previous.length) } : { points };
    this.points = points.map(p => [...p]); this.revision = revision; this.full = false;
    return value;
  }
}
