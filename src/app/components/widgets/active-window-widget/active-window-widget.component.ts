import {
  Component,
  Inject,
  NgZone,
  OnDestroy,
  OnInit,
  ViewEncapsulation,
} from "@angular/core";
import { ActiveWindowWidgetProps } from "../../../../bindings/widget/active_window/ActiveWindowWidgetProps";
import {
  Event as TauriEvent,
  UnlistenFn,
  listen,
  emit,
} from "@tauri-apps/api/event";
import { currentMonitor } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/tauri";
import { tryFormatEval } from "../../../../utils/format";
import { ActiveWindowPayload } from "../../../../bindings/widget/active_window/ActiveWindowPayload";
import { WIDGET_PROPS } from "..";
import { CallbackWidgetComponent } from "../callback-widget.component";
import { ActiveWindowCallbackType } from "../../../../bindings/widget/active_window/ActiveWindowCallbackType";
import { WidgetCallbacks } from "../../../../bindings/widget/base/WidgetCallbacks";

const NAVIGATION_CLASSES = [
  "SHELLDLL_DefView",
  "Windows.UI.Input.InputSite.WindowClass",
  "ToolbarWindow32",
  "SysTreeView32",
  "DirectUIHWND",
  "ComboLBox",
];
const IGNORED_PROCESSES = ["SearchHost.exe", "ShellExperienceHost.exe"];
const IGNORED_CLASSES = [
  "WorkerW",
  "NotifyIconOverflowWindow",
  "XamlExplorerHostIslandWindow",
  "Windows.UI.Core.CoreWindow",
];
const DEFAULT_LABEL = "${win.title} ${win.class} ${win.process}";

@Component({
  selector: "active-window-widget",
  templateUrl: "./active-window-widget.component.html",
  encapsulation: ViewEncapsulation.None,
})
export class ActiveWindowWidgetComponent
  extends CallbackWidgetComponent
  implements OnInit, OnDestroy
{
  public activeLabelTooltip?: string;
  public activeLabelFormatted?: string;
  public isHidden = true;
  public isError = false;

  private ignoredClasses: string[];
  private ignoredProcesses: string[];
  private ignoredTitles: string[];
  private unformattedActiveLabel: string;
  private currentMonitorName: string | null | undefined;
  private showAltLabel = false;
  private activeWindow?: ActiveWindowPayload;
  private activeWindowUnlistener?: UnlistenFn;
  private jsonPopupWidth = 500;
  private jsonPopupHeight = 260;
  private jsonPopupPadding = 10;
  private isJsonViewerCallbackConfigured = false;

  public constructor(
    @Inject(WIDGET_PROPS) public props: ActiveWindowWidgetProps,
    public ngZone: NgZone
  ) {
    super(props?.callbacks as WidgetCallbacks<ActiveWindowCallbackType>);
    this.isJsonViewerCallbackConfigured = Object.values(
      this.props?.callbacks ?? {}
    ).some((c) => c === "toggle_json_viewer");

    this.unformattedActiveLabel = this.props.label ?? DEFAULT_LABEL;
    this.ignoredTitles = [...(this.props.ignored_windows?.by_class ?? [])];
    this.ignoredClasses = [
      ...IGNORED_CLASSES,
      ...(this.props.ignored_windows?.by_title ?? []),
    ];
    this.ignoredProcesses = [
      ...IGNORED_PROCESSES,
      ...(this.props.ignored_windows?.by_process ?? []),
    ];
  }

  public async ngOnInit(): Promise<void> {
    this.currentMonitorName = (await currentMonitor())?.name;
    this.activeWindowUnlistener = await listen(
      "ActiveWindowChanged",
      this.onActiveWindowChange.bind(this)
    );
    await invoke("init_win_event_hook");
    await invoke("detect_foreground_window");
    this.isHidden = false;
    this.activeLabelFormatted = this.unformattedActiveLabel;
    this.updateLabels();
  }

  public async ngOnDestroy(): Promise<void> {
    await super.ngOnDestroy();
    if (this.activeWindowUnlistener) {
      this.activeWindowUnlistener();
    }
  }

  protected mapCallback(
    callbackType: string
  ): ((event: MouseEvent, callbackType: string) => void) | undefined {
    switch (callbackType) {
      case "toggle_label":
        return this.toggleActiveLabel.bind(this);
      case "toggle_json_viewer":
        return this.toggleJsonViewer.bind(this);
      default:
        return;
    }
  }

  private async toggleJsonViewer(event: MouseEvent): Promise<void> {
    if (!this.popupWebview && this.isJsonViewerCallbackConfigured) {
      await this.createPopupWindow(
        event,
        "json-viewer",
        this.jsonPopupWidth,
        this.jsonPopupHeight,
        this.jsonPopupPadding
      );
      const unlisten = await listen(
        `${(this.popupWebview as any).label}_init`,
        async () => {
          await emit(`${this.popupWebview?.label}_data`, this.activeWindow);
          unlisten();
        }
      );
    } else if (await this.popupWebview?.isVisible()) {
      await this.popupWebview?.hide();
    } else if (this.popupWebview) {
      await emit(`${this.popupWebview?.label}_data`, this.activeWindow);
      await this.showPopupWindow(
        event,
        this.jsonPopupWidth,
        this.jsonPopupHeight,
        this.jsonPopupPadding
      );
    }
  }

  public getClasses(): any {
    const classes: any = { error: this.isError, hidden: this.isHidden };

    if (this.props.class) {
      classes[this.props.class] = true;
    }

    return classes;
  }

  private async onActiveWindowChange(
    event: TauriEvent<ActiveWindowPayload>
  ): Promise<void> {
    console.log(event.payload);
    if (
      event.payload.title &&
      this.activeWindow?.title != event.payload.title &&
      event.payload.title !== "yasb-popup" &&
      !(
        // ignore popup webview windows
        (
          event.payload.exe_name === "msedgewebview2.exe" &&
          ["about:blank", "Untitled"].includes(event.payload.title)
        )
      )
    ) {
      this.activeWindow = event.payload;
      this.execData = this.activeWindow;
      if (await this.popupWebview?.isVisible()) {
        await emit(`${this.popupWebview?.label}_data`, this.activeWindow);
      }
      this.hideOrUpdateContent();
    }
  }

  private async hideOrUpdateContent(): Promise<void> {
    if (
      this.ignoredProcesses?.includes(this.activeWindow?.exe_name ?? "") ||
      this.ignoredClasses?.includes(this.activeWindow?.class ?? "") ||
      this.ignoredTitles?.includes(this.activeWindow?.title ?? "")
    ) {
      this.isHidden = true;
    } else {
      this.isHidden =
        !!this.props.is_monitor_exclusive &&
        this.activeWindow?.monitor != this.currentMonitorName;

      if (
        !this.isHidden &&
        NAVIGATION_CLASSES.includes(this.activeWindow?.class ?? "")
      ) {
        return await invoke("detect_foreground_window");
      }

      this.updateLabels();
    }
  }

  private updateLabels(): void {
    if (!this.activeWindow) {
      this.isHidden = true;
      return;
    }

    try {
      this.activeLabelFormatted = tryFormatEval(
        this.unformattedActiveLabel,
        this.activeWindow
      );
      this.isError = false;
    } catch (error) {
      this.activeLabelFormatted = this.unformattedActiveLabel;
      this.activeLabelTooltip = `Error formatting active label:\n\n${
        (error as Error).message
      }`;
      this.isError = true;
    }

    if (
      this.props?.label_max_len &&
      this.activeLabelFormatted.length > this.props.label_max_len
    ) {
      this.activeLabelFormatted =
        this.activeLabelFormatted.substring(0, this.props.label_max_len) +
        "...";
    }
  }

  public async toggleActiveLabel(): Promise<void> {
    this.showAltLabel = !this.showAltLabel;
    this.unformattedActiveLabel =
      (this.showAltLabel ? this.props.label_alt : this.props.label) ??
      DEFAULT_LABEL;
    this.updateLabels();
  }
}