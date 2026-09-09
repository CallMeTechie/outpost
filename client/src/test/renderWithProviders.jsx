import { render } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import testI18n from "./i18n.js";

// The providers a component actually needs, named by the test. Root.jsx nests 15
// of them; hanging all 15 into every test would be slow and would hide what a
// component really depends on.
//
// i18n is not one of the choices. useTranslation without an instance yields keys
// instead of text, which makes every text assertion worthless, so the
// I18nextProvider always sits outermost.
export const renderWithProviders = (ui, { providers = [], ...renderOptions } = {}) => {
    const Wrapper = ({ children }) => (
        <I18nextProvider i18n={testI18n}>
            {/* reduceRight so the first entry ends up outermost, which is how a
                reader expects a nesting list to read. */}
            {providers.reduceRight(
                (tree, Provider) => <Provider>{tree}</Provider>,
                children,
            )}
        </I18nextProvider>
    );

    return render(ui, { wrapper: Wrapper, ...renderOptions });
};
