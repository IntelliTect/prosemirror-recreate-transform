/* eslint-disable no-empty */
import { Fragment, Slice, Node } from "prosemirror-model";
import { Transform, ReplaceStep, Step, ReplaceAroundStep } from "prosemirror-transform";
import { getReplaceStep } from "./getReplaceStep";


// join adjacent ReplaceSteps
export function simplifyTransform(tr: Transform) {
    if (!tr.steps.length) {
        return undefined;
    }

    const newTr = new Transform(tr.docs[0]);
    const oldSteps = tr.steps.slice();

    while (oldSteps.length) {
        let step = oldSteps.shift();
        while (oldSteps.length && step.merge(oldSteps[0])) {
            const addedStep = oldSteps.shift();
            if (step instanceof ReplaceStep && addedStep instanceof ReplaceStep) {
                step = getReplaceStep(newTr.doc, addedStep.apply(step.apply(newTr.doc).doc).doc) as Step;
            } else {
                step = step.merge(addedStep);
            }
        }
        newTr.step(step);
    }
    return newTr;
}



export function simplifyTransform2(oldTr: Transform) {
    if (!oldTr.steps.length) {
        return undefined;
    }

    const newTr = new Transform(oldTr.docs[0]) as (Transform & {addStep(step: Step, doc: Node): void});
    const oldSteps = oldTr.steps.slice();

    for (let i = 0; i < oldTr.steps.length; i++) {
        const step = oldTr.steps[i];

        if (step instanceof ReplaceStep) {
          let nextStep = oldTr.steps[i + 1];

          if (step.from == step.to && nextStep instanceof ReplaceStep && nextStep.slice.size == 0) {

            // Reconstruct tr.join(), which recreateTransform tends to yield as an insertion + deletion.
            // Try joining at the position one after the insertion (which will be the spot "between" the two existing nodes)
            try {
              const pos = step.from + 1;
              const depth = 1;
              const newStep = new ReplaceStep(pos - depth, pos + depth, Slice.empty, true);

              // See if the join produced the end state of `step` and `nextStep`.
              const result = newStep.apply(newTr.doc);
              if (!result.failed && result.doc.content.findDiffStart((oldTr.docs[i + 2] || oldTr.doc).content) == null) {
                newTr.addStep(newStep, result.doc);
                i++; // Consume nextStep (`step` accounted for by loop counter)
                continue;
              }
            } catch {}


            // Reconstruct sinkListItem(), which yields a ReplaceAroundStep.
            // E.g. indenting a nested list:
            /*
              * abc            * abc
              * def       =>     * def
                * ghi              * ghi
                * jkl              * jkl
            */
            try {
              // @ts-expect-error
              const slice = new Slice(Fragment.from(step.slice.content.content[0].content.content[0].type.create(null, Fragment.from(step.slice.content.content[0].type.create(null, Fragment.from(null))))), 1, 0)

              const newStep = new ReplaceAroundStep(step.from, step.from + step.slice.size - 1, step.from + 1, step.from + step.slice.size - 1, slice, 1, true);

              // See if the join produced the end state of `step` and `nextStep`.
              const result = newStep.apply(newTr.doc);
              if (!result.failed && result.doc.content.findDiffStart((oldTr.docs[i + 2] || oldTr.doc).content) == null) {
                newTr.addStep(newStep, result.doc);
                i++; // Consume nextStep (`step` accounted for by loop counter)
                continue;
              }
            } catch {}
          }


          // Reconstruct tr.split(), which recreateTransform will yield as a deletion + insertion.
          let removedText = '';
          let removalSteps = 0;
          let removalStep: Step = step;

          // Find all consecutive steps that remove content (an empty new slice is a removal).
          // When splitting a list on a non-leaf node, this will probably be 2 steps.
          // For splitting paragraphs and leaf list nodes, this is probably 1 step.
          while (removalStep instanceof ReplaceStep && removalStep.slice.size == 0) {
            nextStep = oldTr.steps[i + 1 + removalSteps];
            removedText += oldTr.docs[i + removalSteps].textBetween(removalStep.from, removalStep.to);

            removalSteps++;
            removalStep = nextStep;
          }

          if (
            nextStep instanceof ReplaceStep &&
            // There was one or more removals
            removalSteps > 0 &&
            // The next step is an insert (i.e. it doesn't actually replace anything, so its replacement range is zero)
            nextStep.from == nextStep.to &&
            // The text being removed is the same as the text being inserted
            removedText == (oldTr.docs[i + 1 + removalSteps] || oldTr.doc).textBetween(nextStep.from, nextStep.from + nextStep.slice.size)
          ) {
            let depth = 0;
            let newContent = nextStep.slice;
            const types: any[] = []
            // @ts-expect-error
            while ((newContent = newContent.content.content[0]) && !newContent.isText) {
              types.push(newContent)
              depth++;
            }

            const oldResolved = oldTr.docs[0].resolve(step.from)

            // Check that the types of the new nodes match the old ones.
            // Without this, some operations like an undo of a backspace that turned a list_item
            // into a bare paragraph would try to use this codepath, and fail.
            let typesMatch = true;
            for (let d = 0; d < types.length; d++) {
              const expectedType = types[d].type;

              const oldNode = oldResolved.node(oldResolved.depth - (types.length - d) + 1)
              if (expectedType != oldNode.type) {
                typesMatch = false;
                break;
              }
            }

            if (typesMatch) {
              i += removalSteps; // Consume all removal steps (nextStep accounted for by loop counter)
              newTr.split(step.from, depth, types);
              continue;
            }


          }
        }

        newTr.step(step)
      }

    return newTr;
}
