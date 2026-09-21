import React from "react";
import { render } from "@testing-library/react-native";
import { NativeTabsNavigator } from "expo-router/build/native-tabs/NativeBottomTabsNavigator";
import { convertTabPropsToOptions } from "expo-router/build/native-tabs/NativeTabTrigger";
import {
  BaseNavigationContainer,
  createNavigatorFactory,
} from "expo-router/build/react-navigation/core";

jest.mock(
  "query-string",
  () => ({ stringify: () => "", parse: () => ({}) }),
  { virtual: true },
);

const recorded: unknown[] = [];
jest.mock("expo-router/build/native-tabs/NativeTabsView", () => ({
  NativeTabsView: (props: unknown) => {
    recorded.push(props);
    return null;
  },
}));

it("spike", () => {
  const { Screen } = createNavigatorFactory(NativeTabsNavigator)();
  const Empty = () => null;
  const opts = convertTabPropsToOptions({ hidden: false, children: null } as never);
  console.log("trigger options", JSON.stringify(opts));
  render(
    <BaseNavigationContainer>
      <NativeTabsNavigator
        backgroundColor="#0E1118"
        blurEffect="none"
        disableTransparentOnScrollEdge
        shadowColor="#343D4C"
        tintColor="#5AA5FA"
        iconColor={{ default: "#9AA4B5", selected: "#5AA5FA" }}
        labelStyle={{ default: { color: "#9AA4B5" }, selected: { color: "#5AA5FA" } }}
      >
        <Screen name="index" options={opts} component={Empty} />
        <Screen name="profile" options={opts} component={Empty} />
      </NativeTabsNavigator>
    </BaseNavigationContainer>,
  );
  const props = recorded[0] as { tabs: { name: string; options: unknown }[] } & Record<string, unknown>;
  console.log("top-level keys", Object.keys(props));
  console.log("tabs", JSON.stringify(props.tabs.map((t) => ({ name: t.name, options: t.options })), null, 2));
});
