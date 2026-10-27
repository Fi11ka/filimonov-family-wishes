import React from "react";
import { RefreshCw } from "lucide-react";
/**
 * A mistake while drawing the app shows this instead of a blank page.
 * Nothing about the error is sent anywhere (see SECURITY.md).
 */
export class ErrorScreen extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="error-screen">
        <div className="empty" role="alert">
          <h3>Что-то пошло не так</h3>
          <p>
            Обновите страницу. Ваши желания и брони сохранены: ошибка только на
            экране.
          </p>
          <button className="button primary" onClick={() => location.reload()}>
            <RefreshCw size={16} />
            Обновить
          </button>
        </div>
      </div>
    );
  }
}
