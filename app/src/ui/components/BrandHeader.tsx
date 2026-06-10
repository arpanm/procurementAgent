/**
 * Shared branded app header. Presentational only — renders the Procure Copilot brand mark plus a
 * title/subtitle inside an Ionic toolbar, with an optional trailing slot for actions. Reused across
 * every screen so the app feels like one cohesive product.
 */
import { IonHeader, IonToolbar } from "@ionic/react";
import type { ReactNode } from "react";
import { BrandLogo } from "./BrandLogo";

export interface BrandHeaderProps {
  /** Primary line — the brand name or a screen title. */
  readonly title: string;
  /** Optional secondary line under the title (e.g. brand tagline or step hint). */
  readonly subtitle?: string;
  /** Optional trailing content rendered at the end of the toolbar. */
  readonly end?: ReactNode;
}

export function BrandHeader({ title, subtitle, end }: BrandHeaderProps): JSX.Element {
  return (
    <IonHeader className="ion-no-border">
      <IonToolbar className="pc-toolbar">
        <div className="pc-brand">
          <span className="pc-brand__mark">
            <BrandLogo size={30} title="Procure Copilot" />
          </span>
          <span>
            <span className="pc-brand__name">{title}</span>
            {subtitle ? <span className="pc-brand__sub">{subtitle}</span> : null}
          </span>
        </div>
        {end ? <div slot="end">{end}</div> : null}
      </IonToolbar>
    </IonHeader>
  );
}
