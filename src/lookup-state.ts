type Field = "title" | "price" | "photo" | "description";
/** A request loses ownership when its URL changes or the user edits a field. */
export class LookupState {
  private request = 0;
  private edits = { title: 0, price: 0, photo: 0, description: 0 };
  invalidate() {
    ++this.request;
  }
  edit(field: Field) {
    ++this.edits[field];
  }
  begin(allowed: Partial<Record<Field, boolean>>) {
    const id = ++this.request,
      edits = { ...this.edits };
    const current = () => id === this.request;
    return {
      current,
      canApply: (field: Field) =>
        current() && !!allowed[field] && edits[field] === this.edits[field],
    };
  }
}
