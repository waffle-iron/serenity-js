import * as _ from 'lodash';
import * as path from 'path';
import StackTrace = require('stacktrace-js');
import { StackFrame } from 'stacktrace-js';
import { Md5 } from 'ts-md5/dist/md5';

import { DomainEvent, Photo, RecordedScene, Result, SceneFinished, Tag } from '../domain';
import { FileSystem, JSONObject } from '../io';
import { Default_Path_To_Reports } from '../serenity';
import { Stage, StageCrewMember } from '../stage';
import { ActivityPeriod, RehearsalPeriod, ReportExporter, ScenePeriod } from './index';
import { RehearsalReport } from './rehearsal_report';
import {
    ActivityReport,
    ErrorReport,
    ErrorReportStackFrame,
    FullReport,
    SceneReport,
    ScreenshotReport,
    TagReport,
} from './serenity_bdd_report';

export function serenityBDDReporter(pathToReports: string = Default_Path_To_Reports): StageCrewMember {
    return new SerenityBDDReporter(new FileSystem(pathToReports));
}

export class SerenityBDDReporter implements StageCrewMember {

    private static Events_of_Interest = [ SceneFinished ];
    private stage: Stage;

    constructor(private fs: FileSystem) {
    }

    assignTo(stage: Stage) {
        this.stage = stage;
        this.stage.manager.registerInterestIn(SerenityBDDReporter.Events_of_Interest, this);
    }

    notifyOf(event: DomainEvent<any>): void {
        switch (event.constructor.name) { // tslint:disable-line:switch-default - ignore other events
            case SceneFinished.name:    return this.persistReportFor(event);
        }
    }

    private persistReportFor({ value }: SceneFinished) {
        const filename = `${ Md5.hashStr(value.subject.id) }.json`;

        this.stage.manager.informOfWorkInProgress(
            RehearsalReport.from(this.stage.manager.readNewJournalEntriesAs('SerenityBDDReporter'))
                .exportedUsing(new SerenityBDDReportExporter())
                .then((fullReport: FullReport) => Promise.all(
                    fullReport.scenes.map(
                        (scene: SceneReport) => this.fs.store(filename, JSON.stringify(scene)),
                    ),
                )),
        );
    }
}

/**
 * Transforms the tree structure of the RehearsalPeriod to a format acceptable by Protractor
 */
export class SerenityBDDReportExporter implements ReportExporter<JSONObject> {

    private errorExporter = new ErrorExporter();
    private photoExporter = new PhotoExporter();

    exportRehearsal(node: RehearsalPeriod): PromiseLike<FullReport> {
        return Promise.all(node.children.map(child => child.exportedUsing(this)))
            .then(children => ({
                scenes: children,
            }));
    }

    exportScene(node: ScenePeriod): PromiseLike<SceneReport> {
        return Promise.all(node.children.map(child => child.exportedUsing(this)))
            .then((children: ActivityReport[]) => this.errorExporter.tryToExport(node.outcome.error).then(error => ({
                title:          node.value.name,
                name:           node.value.name,
                description:    '',
                startTime:      node.startedAt,
                duration:       node.duration(),
                driver:         'unknown',          // todo: provide the correct driver information for web tests
                testSource:     'cucumber',         // todo: provide the correct test source
                manual:         false,
                result:         Result[node.outcome.result],
                userStory:      {
                    id:         this.dashified(node.value.category),
                    path:       path.relative(process.cwd(), node.value.location.path),
                    storyName:  node.value.category,
                    type:       'feature',
                },
                tags:           this.tagsFor(node.value),
                issues:         this.issuesCoveredBy(node.value),
                testSteps:      children,

                annotatedResult:  Result[node.outcome.result],
                testFailureCause: error,
            })));
    }

    exportActivity(node: ActivityPeriod): PromiseLike<ActivityReport> {
        return Promise.all(node.children.map(child => child.exportedUsing(this)))
            .then((children: ActivityReport[]) => Promise.all([ node.photos(), this.errorExporter.tryToExport(node.outcome.error)]).then( r => ({
                description: node.value.name,
                duration:    node.duration(),
                startTime:   node.startedAt,
                screenshots: this.photoExporter.tryToExport(r[0]),
                result:      Result[node.outcome.result],
                children,
                exception:   r[1], // this.errorExporter.tryToExport(node.outcome.error),
            })));
    }

    private dashified = (name: string) => name
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/[ \t\W]/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();

    private issuesCoveredBy(scene: RecordedScene): string[] {
        const onlyIssueTags = this.isAnIssue,
              toIssueIds    = (tag: Tag): string[] => tag.values;

        return _.chain(scene.tags).filter(onlyIssueTags).map(toIssueIds).flatten().uniq().value() as string[];
    }

    private tagsFor(scene: RecordedScene): TagReport[] {

        const isAnIssue = this.isAnIssue;

        function serialise(tag: Tag) {
            const noValue   = (t: Tag) => ({ name: t.type,  type: 'tag' }),
                  withValue = (t: Tag) => ({ name: t.values.join(','), type: t.type });

            return tag.values.length === 0
                ? noValue(tag)
                : withValue(tag);
        }

        function breakDownIssues(tag: Tag) {
            return isAnIssue(tag)
                ? tag.values.map(issueId => new Tag('issue', [ issueId ]))
                : tag;
        }

        function featureTag(featureName: string) {
            return {
                name: featureName,
                type: 'feature',
            };
        }

        return _.chain(scene.tags)
            .map(breakDownIssues)
            .flatten()
            .map(serialise)
            .uniqBy('name')
            .concat(featureTag(scene.category))
            .value();
    }

    private isAnIssue = (tag: Tag): boolean => !! ~['issue', 'issues'].indexOf(tag.type);
}

class PhotoExporter {
    tryToExport(photos: Photo[]): ScreenshotReport[] {
        return this.ifNotEmpty(photos.map(photo => ({ screenshot: path.basename(photo.path) })));
    }

    private ifNotEmpty = <T>(list: T[]): T[] => !! list.length ? list : undefined;
}

class ErrorExporter {
    tryToExport(error: Error): PromiseLike<ErrorReport> {
        if (! error) {
            return Promise.resolve(undefined); // an undefined JSON field does not get serialised and that's what Serenity BDD expects
        }

        return this.stackTraceOf(error).then(frames => ({
            errorType:    error.name,
            message:      error.message,
            stackTrace:   frames,
        }));
    }

    private stackTraceOf(error: Error): PromiseLike<ErrorReportStackFrame[]> {
        return !! error.stack ? this.parsedStackTraceOf(error) : Promise.resolve([]);
    }

    private parsedStackTraceOf(error: Error): PromiseLike<ErrorReportStackFrame[]> {
        const
            serenityCode = /node_modules[\\/]serenity/,
            onlyIfFound  = index => !! ~index ? index : undefined,
            firstSerenityStackFrame = (stack: StackFrame[]): number => onlyIfFound(stack.findIndex(frame => !! serenityCode.exec(frame.fileName))),
            stack = StackTrace.fromError(error);

        return stack.then(frames => frames.slice(0, firstSerenityStackFrame(frames)).map(frame => {
            return {
                declaringClass: '',
                methodName:     `${ frame.functionName }(${ (frame.args || []).join(', ') })`,
                fileName:       frame.fileName,
                lineNumber:     frame.lineNumber,
            };
        }));
    }
}
