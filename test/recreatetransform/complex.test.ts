import pmTestBuilder from "prosemirror-test-builder";
import { recreateTransform, Options } from "../../src/recreateTransform";
const { schema, doc, blockquote, h1, h2, p, em, strong, ul, li } = pmTestBuilder;


function testRecreate(startDoc, endDoc, steps = [], options: Options = {}) {
    const tr = recreateTransform(startDoc, endDoc, options);
    expect(JSON.stringify(tr.steps.map(step => step.toJSON()))).toBe(JSON.stringify(steps));
}


describe("recreateTransform - complex node diffs", () => {

    it("add em", () =>
        testRecreate(
            doc(p("Before textitalicAfter text")),
            doc(p("Before text", em("italic"), "After text")),
            [{
                stepType: "addMark",
                mark: {
                    type: "em"
                },
                from: 12,
                to: 18
            }]
        )
    );

    it("remove strong", () =>
        testRecreate(
            doc(p("Before text", strong("bold"), "After text")),
            doc(p("Before textboldAfter text")),
            [{
                stepType: "removeMark",
                mark: {
                    type: "strong"
                },
                from: 12,
                to: 16
            }]
        )
    );

    it("add em and strong", () =>
        testRecreate(
            doc(p("Before textitalic/boldAfter text")),
            doc(p("Before text", strong(em("italic/bold")), "After text")),
            [{
                stepType: "addMark",
                mark: {
                    type: "em"
                },
                from: 12,
                to: 23
            },
            {
                stepType: "addMark",
                mark: {
                    type: "strong"
                },
                from: 12,
                to: 23
            }]
        )
    );

    it("replace em and strong", () =>
        testRecreate(
            doc(p("Before textitalic/boldAfter text")),
            doc(p("Before text", strong(em("italic/bold")), "After text")),
            [{
                stepType: "addMark",
                mark: {
                    type: "em"
                },
                from: 12,
                to: 23
            },
            {
                stepType: "addMark",
                mark: {
                    type: "strong"
                },
                from: 12,
                to: 23
            }]
        )
    );

    it("replace em with strong", () =>
        testRecreate(
            doc(p("Before text", em("styled"), "After text")),
            doc(p("Before text", strong("styled"), "After text")),
            [{
                stepType: "removeMark",
                mark: {
                    type: "em"
                },
                from: 12,
                to: 18
            },
            {
                stepType: "addMark",
                mark: {
                    type: "strong"
                },
                from: 12,
                to: 18
            }]
        )
    );

    it("replace em with strong in different parts", () =>
        testRecreate(
            doc(p("Before text", em("styledAfter text"))),
            doc(p(strong("Before textstyled"), "After text")),
            [{
                stepType: "addMark",
                mark: {
                    type: "strong"
                },
                from: 1,
                to: 12
            }, {
                stepType: "removeMark",
                mark: {
                    type: "em"
                },
                from: 12,
                to: 18
            }, {
                stepType: "addMark",
                mark: {
                    type: "strong"
                },
                from: 12,
                to: 18
            }, {
                stepType: "removeMark",
                mark: {
                    type: "em"
                },
                from: 18,
                to: 28
            }]
        )
    );



    it("wrap in blockquote", () =>
        testRecreate(
            doc(p("A quoted sentence")),
            doc(blockquote(p("A quoted sentence"))),
            [{
                stepType: "replace",
                from: 0,
                to: 19,
                slice: {
                    content: [{
                        type: "blockquote",
                        content: [{
                            type: "paragraph",
                            content: [{
                                type: "text",
                                text: "A quoted sentence"
                            }]
                        }]
                    }]
                }
            }]
        )
    );

    it("unwrap from blockquote", () =>
        testRecreate(
            doc(blockquote(p("A quoted sentence"))),
            doc(p("A quoted sentence")),
            [{
                stepType: "replace",
                from: 0,
                to: 21,
                slice: {
                    content: [{
                        type: "paragraph",
                        content: [{
                            type: "text",
                            text: "A quoted sentence"
                        }]
                    }]
                }
            }]
        )
    );

    it("change headline type", () =>
        testRecreate(
            doc(h1("A title")),
            doc(h2("A title")),
            [{
                stepType: "replaceAround",
                from: 0,
                to: 9,
                gapFrom: 1,
                gapTo: 8,
                insert: 1,
                slice: {
                    content: [{
                        type: "heading",
                        attrs: {
                            level: 2
                        }
                    }]
                },
                structure: true
            }],
            { complexSteps: true }
        )
    );

});



import {EditorState, Selection, TextSelection, Transaction} from "prosemirror-state"
import {Schema, DOMParser} from "prosemirror-model"
import {addListNodes, liftListItem, sinkListItem, splitListItem} from "prosemirror-schema-list"

describe("simplifyTransform2", () => {

    function makeDoc(selectionPos: number, doc) {
        const state = EditorState.create({doc, schema, selection: Selection.fromJSON(doc, {type: "text", anchor: selectionPos, head: selectionPos}) })
        return state;
    }

    function doTest(initialState: EditorState, buildTransform: (doc: EditorState) => Transaction) {
        const originalTr = buildTransform(initialState);

        const reconstructedTr = recreateTransform(initialState.doc, originalTr.doc, {complexSteps: true, wordDiffs: false, simplifyDiff: true});

        // Check that the original transform and the recreated transform produced the same doc
        expect(originalTr.doc.toJSON()).toEqual(reconstructedTr.doc.toJSON());

        // Check that they did so with the same steps.
        expect(originalTr.steps.map(step => step.toJSON())).toEqual(reconstructedTr.steps.map(step => step.toJSON()));
    }

    function dispatch<T>(f: (a: (d: T) => void) => void): T {
        let result: T;
        f((d: T) => { result = d; });
        return result;
    }

    it("indent top level list item at end of list", () => {
        doTest(
            makeDoc(10, doc(ul(
                li(p("abc")),
                li(p("def")),
            ))),
            state => dispatch(dispatch => { sinkListItem(state.schema.nodes.list_item)(state, dispatch) })
        );
    })

    // it("merge top level list item at end of list", () => {
    //     doTest(
    //         makeDoc(10, doc(ul(
    //             li(p("abc")),
    //             li(p("def")),
    //         ))),
    //         state => dispatch(dispatch => { liftListItem(state.schema.nodes.list_item)(state, dispatch) })
    //     );
    // })

    it("split top level list item inside list", () => {
        doTest(
            makeDoc(4, doc(ul(
                li(p("abc")),
                li(p("def")),
            ))),
            state => dispatch(dispatch => { splitListItem(state.schema.nodes.list_item)(state, dispatch) })
        );
    })

    it("split top level list item at end of list", () => {
        doTest(
            makeDoc(11, doc(ul(
                li(p("abc")),
                li(p("def")),
            ))),
            state => dispatch(dispatch => { splitListItem(state.schema.nodes.list_item)(state, dispatch) })
        );
    })
})
