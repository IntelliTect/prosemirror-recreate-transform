import { Transform } from "prosemirror-transform";
import { Node, Schema } from "prosemirror-model";
import { applyPatch, createPatch, Operation } from "rfc6902";
import { diffWordsWithSpace, diffChars } from "diff";
import { AnyObject } from "./types";
import { getReplaceStep } from "./getReplaceStep";
import { simplifyTransform } from "./simplifyTransform";
import { removeMarks } from "./removeMarks";
import { getFromPath } from "./getFromPath";
import { copy } from "./copy";


export interface Options {
    complexSteps?: boolean;
    wordDiffs?: boolean;
}


export class RecreateTransform {
    fromDoc: Node;
    toDoc: Node;
    complexSteps: boolean;
    wordDiffs: boolean;
    schema: Schema;
    tr: Transform;
    /* current working document data, may get updated while recalculating node steps */
    currentJSON: AnyObject;
    /* final document as json data */
    finalJSON: AnyObject;
    ops: Array<Operation>;

    constructor(fromDoc: Node, toDoc: Node, options: Options = {}) {
        const o = {
            complexSteps: true,
            wordDiffs: false,
            ...options
        };

        this.fromDoc = fromDoc;
        this.toDoc = toDoc;
        this.complexSteps = o.complexSteps; // Whether to return steps other than ReplaceSteps
        this.wordDiffs = o.wordDiffs; // Whether to make text diffs cover entire words
        this.schema = fromDoc.type.schema;
        this.tr = new Transform(fromDoc);
    }

    init() {
        if (this.complexSteps) {
            // For First steps: we create versions of the documents without marks as
            // these will only confuse the diffing mechanism and marks won't cause
            // any mapping changes anyway.
            this.currentJSON = removeMarks(this.fromDoc).toJSON();
            this.finalJSON = removeMarks(this.toDoc).toJSON();
            this.ops = createPatch(this.currentJSON, this.finalJSON);
            this.recreateChangeContentSteps();
            this.recreateChangeMarkSteps();

        } else {
            // We don't differentiate between mark changes and other changes.
            this.currentJSON = this.fromDoc.toJSON();
            this.finalJSON = this.toDoc.toJSON();
            this.ops = createPatch(this.currentJSON, this.finalJSON);
            this.recreateChangeContentSteps();
        }

        this.tr = simplifyTransform(this.tr) || this.tr;
        return this.tr;
    }

    /** convert json-diff to prosemirror steps */
    recreateChangeContentSteps() {
        // First step: find content changing steps.
        let ops = [];
        while (this.ops.length) {
            let op = this.ops.shift();
            ops.push(op);

            let toDoc;
            const afterStepJSON = copy(this.currentJSON);
            const pathParts = op.path.split("/");

            // collect operations until we receive a valid document
            while (toDoc == null) {
                applyPatch(afterStepJSON, [op]);

                try {
                    toDoc = this.schema.nodeFromJSON(afterStepJSON);
                    toDoc.check();

                } catch (error) {
                    toDoc = null;
                    if (this.ops.length > 0) {
                        op = this.ops.shift();
                        ops.push(op);

                    } else {
                        throw new Error(`No valid diff possible applying ${op.path}`);
                    }
                }
            }

            // apply the set of operations
            if (this.complexSteps && ops.length === 1 && (pathParts.includes("attrs") || pathParts.includes("type"))) {
                // Node markup is changing
                this.addSetNodeMarkup();
                ops = [];

            } else if (ops.length === 1 && op.op === "replace" && pathParts[pathParts.length - 1] === "text") {
                // Text is being replaced, we apply text diffing to find the smallest possible diffs.
                this.addReplaceTextSteps(op, afterStepJSON);
                ops = [];

            } else if (this.addReplaceStep(toDoc, afterStepJSON)) {
                // operations have been applied
                ops = [];
            }
        }
    }

    recreateChangeMarkSteps() {
        // Now the documents should be the same, except their marks, so everything should map 1:1.
        // Second step: Iterate through the toDoc and make sure all marks are the same in tr.doc
        this.toDoc.descendants((tNode, tPos) => {
            if (!tNode.isInline) {
                return true;
            }

            this.tr.doc.nodesBetween(tPos, tPos + tNode.nodeSize, (fNode, fPos) => {
                if (!fNode.isInline) {
                    return true;
                }
                const from = Math.max(tPos, fPos);
                const to = Math.min(tPos + tNode.nodeSize, fPos + fNode.nodeSize);
                fNode.marks.forEach(nodeMark => {
                    if (!nodeMark.isInSet(tNode.marks)) {
                        this.tr.removeMark(from, to, nodeMark);
                    }
                });
                tNode.marks.forEach(nodeMark => {
                    if (!nodeMark.isInSet(fNode.marks)) {
                        this.tr.addMark(from, to, nodeMark);
                    }
                });
            });
        });
    }

    /**
     * retrieve and possibly apply replace-step based from doc changes
     * From http://prosemirror.net/examples/footnote/
     */
    addReplaceStep(toDoc: Node, afterStepJSON: AnyObject) {
        const fromDoc = this.schema.nodeFromJSON(this.currentJSON);
        const step = getReplaceStep(fromDoc, toDoc);

        if (!step) {
            return false;

        } else if (!this.tr.maybeStep(step).failed) {
            this.currentJSON = afterStepJSON;
            return true; // @change previously null
        }

        throw new Error("No valid step found.");
    }

    /** update node with attrs and marks, may also change type */
    addSetNodeMarkup() {
        const fromDoc = this.schema.nodeFromJSON(this.currentJSON);
        const toDoc = this.schema.nodeFromJSON(this.finalJSON);
        const start = toDoc.content.findDiffStart(fromDoc.content);
        const fromNode = fromDoc.nodeAt(start);
        const toNode = toDoc.nodeAt(start);

        if (start != null) {
            const nodeType = fromNode.type === toNode.type ? null : toNode.type;
            this.tr.setNodeMarkup(start, nodeType, toNode.attrs, toNode.marks);
            this.currentJSON = removeMarks(this.tr.doc).toJSON();
            // Setting the node markup may have invalidated more ops, so we calculate them again.
            this.ops = createPatch(this.currentJSON, this.finalJSON);
        }
    }

    /** retrieve and possibly apply text replace-steps based from doc changes */
    addReplaceTextSteps(op, afterStepJSON) {
        // We find the position number of the first character in the string
        const op1 = { ...op, value: "xx" };
        const op2 = { ...op, value: "yy" };
        const afterOP1JSON = copy(this.currentJSON);
        const afterOP2JSON = copy(this.currentJSON);
        applyPatch(afterOP1JSON, [op1]);
        applyPatch(afterOP2JSON, [op2]);
        const op1Doc = this.schema.nodeFromJSON(afterOP1JSON);
        const op2Doc = this.schema.nodeFromJSON(afterOP2JSON);

        // get text diffs
        const finalText = op.value;
        const currentText = getFromPath(this.currentJSON, op.path);
        const textDiffs = this.wordDiffs ?
            diffWordsWithSpace(currentText, finalText) :
            diffChars(currentText, finalText);

        let offset = op1Doc.content.findDiffStart(op2Doc.content);
        const marks = op1Doc.resolve(offset + 1).marks();

        while (textDiffs.length) {
            const diff = textDiffs.shift();

            if (diff.added) {
                const textNode = this.schema.nodeFromJSON({ type: "text", text: diff.value }).mark(marks);

                if (textDiffs.length && textDiffs[0].removed) {
                    const nextDiff = textDiffs.shift();
                    this.tr.replaceWith(offset, offset + nextDiff.value.length, textNode);

                } else {
                    this.tr.insert(offset, textNode);
                }
                offset += diff.value.length;

            } else if (diff.removed) {

                if (textDiffs.length && textDiffs[0].added) {
                    const nextDiff = textDiffs.shift();
                    const textNode = this.schema.nodeFromJSON({ type: "text", text: nextDiff.value }).mark(marks);
                    this.tr.replaceWith(offset, offset + diff.value.length, textNode);
                    offset += nextDiff.value.length;

                } else {
                    this.tr.delete(offset, offset + diff.value.length);
                }

            } else {
                offset += diff.value.length;
            }
        }

        this.currentJSON = afterStepJSON;
    }
}


export function recreateTransform(fromDoc: Node, toDoc: Node, options: Options = {}): Transform {
    const recreator = new RecreateTransform(fromDoc, toDoc, options);
    return recreator.init();
}
